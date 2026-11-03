"""
Automated tests for StorageManager core object operations:
1. Successful file upload with category prefixes.
2. Object listing and category filtering.
3. File download and byte-for-byte content verification.
4. Metadata and tag retrieval and tag updating.
8. Invalid object handling (ObjectNotFoundError on missing keys).
9. File deletion with explicit confirmation enforcement.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Add parent directory to sys.path so imports work from both root and tests/
PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from config import StorageConfig, StorageConfigError
from storage_manager import (
    LocalS3CompatibleServer,
    ObjectNotFoundError,
    StorageManager,
    StorageOperationError,
)


class TestStorageManagerOperations(unittest.TestCase):
    """Tests core S3/MinIO object storage operations against a local S3-compatible service."""

    server: LocalS3CompatibleServer
    config: StorageConfig
    manager: StorageManager

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = LocalS3CompatibleServer(
            access_key="minioadmin",
            secret_key="minioadmin_test_secret",
        )
        cls.config = StorageConfig(
            endpoint_url=cls.server.endpoint_url,
            access_key="minioadmin",
            secret_key="minioadmin_test_secret",
            bucket_name="test-private-organizer-bucket",
            public_demo_bucket="test-public-sandbox-bucket",
            region="us-east-1",
            default_presigned_expiration=300,
        )
        cls.manager = StorageManager(config=cls.config, use_embedded_s3_client=True)
        cls.manager.ensure_buckets_exist()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.close()

    def setUp(self) -> None:
        # Clear buckets before each test for deterministic isolation
        with self.server.lock:
            self.server.buckets[self.config.bucket_name] = {}
            self.server.buckets[self.config.public_demo_bucket] = {}
            self.server.bucket_policies.clear()

    def test_01_successful_file_upload_and_categorization(self) -> None:
        """Test 1: Successful file upload with category prefix and access status."""
        payload = b"%PDF-1.7 Cloud Security Architecture Specification"
        result = self.manager.upload_file(
            file_content=payload,
            filename="architecture_spec.pdf",
            category="documents",
            metadata={"department": "Security", "owner": "alice", "description": "Spec PDF"},
            tags={"Category": "Academic", "Type": "Report"},
        )

        self.assertEqual(result.key, "documents/architecture_spec.pdf")
        self.assertEqual(result.filename, "architecture_spec.pdf")
        self.assertEqual(result.category, "documents")
        self.assertEqual(result.size_bytes, len(payload))
        self.assertEqual(result.access_mode, "Private")
        self.assertEqual(result.bucket, self.config.bucket_name)

    def test_02_object_listing_and_category_filtering(self) -> None:
        """Test 2: Object listing across categories and search filtering."""
        self.manager.upload_file(b"doc-bytes", "policy.txt", category="documents")
        self.manager.upload_file(b"img-bytes", "diagram.png", category="images")
        self.manager.upload_file(b"rep-bytes", "q3_metrics.csv", category="reports")
        self.manager.upload_file(b"prj-bytes", "roadmap.json", category="projects")

        all_objs = self.manager.list_objects()
        self.assertEqual(len(all_objs), 4)

        reports_only = self.manager.list_objects(category_filter="reports")
        self.assertEqual(len(reports_only), 1)
        self.assertEqual(reports_only[0].key, "reports/q3_metrics.csv")

        searched = self.manager.list_objects(search_query="diagram")
        self.assertEqual(len(searched), 1)
        self.assertEqual(searched[0].key, "images/diagram.png")

    def test_03_file_download_and_content_verification(self) -> None:
        """Test 3: File download into memory and sandboxed storage with byte verification."""
        expected_content = b"id,department,score\n1,CloudSecurity,99\n2,Platform,95\n"
        uploaded = self.manager.upload_file(
            file_content=expected_content,
            filename="audit_results.csv",
            category="reports",
        )

        downloaded_bytes = self.manager.download_file_bytes(uploaded.key)
        self.assertEqual(downloaded_bytes, expected_content)

        saved_path = self.manager.download_to_safe_storage(uploaded.key)
        self.assertTrue(saved_path.is_file())
        self.assertEqual(saved_path.read_bytes(), expected_content)
        # Clean up test file in storage/
        saved_path.unlink(missing_ok=True)

    def test_04_metadata_and_tag_retrieval_and_update(self) -> None:
        """Test 4: Custom metadata and S3 object tag retrieval and dynamic tag updates."""
        uploaded = self.manager.upload_file(
            file_content=b"Research dataset summary",
            filename="research_notes.txt",
            category="projects",
            metadata={
                "department": "ResearchLab",
                "owner": "dr_patel",
                "description": "Zero-trust storage benchmark",
            },
            tags={"Category": "Academic", "Type": "Report"},
        )

        meta, tags, content_type = self.manager.get_object_metadata_and_tags(uploaded.key)
        self.assertEqual(meta["department"], "ResearchLab")
        self.assertEqual(meta["owner"], "dr_patel")
        self.assertEqual(meta["description"], "Zero-trust storage benchmark")
        self.assertEqual(tags["Category"], "Academic")
        self.assertEqual(tags["Type"], "Report")
        self.assertIn("text/plain", content_type)

        updated_tags = self.manager.update_object_tags(
            uploaded.key,
            {"Category": "Enterprise", "Type": "Audit", "Classification": "Confidential"},
        )
        self.assertEqual(updated_tags["Classification"], "Confidential")

        _, refreshed_tags, _ = self.manager.get_object_metadata_and_tags(uploaded.key)
        self.assertEqual(refreshed_tags["Category"], "Enterprise")
        self.assertEqual(refreshed_tags["Type"], "Audit")
        self.assertEqual(refreshed_tags["Classification"], "Confidential")

    def test_08_invalid_object_handling(self) -> None:
        """Test 8: Attempting to download, inspect, or pre-sign a non-existent object raises ObjectNotFoundError."""
        with self.assertRaises(ObjectNotFoundError):
            self.manager.download_file_bytes("documents/non_existent_file.pdf")

        with self.assertRaises(ObjectNotFoundError):
            self.manager.get_object_metadata_and_tags("images/missing_logo.png")

        with self.assertRaises(ObjectNotFoundError):
            self.manager.generate_presigned_url("reports/ghost_report.csv", expiration_seconds=60)

        with self.assertRaises(StorageConfigError):
            self.manager.upload_file(b"data", "bad.txt", category="unsupported_folder")

    def test_09_file_deletion_and_confirmation_guard(self) -> None:
        """Test 9: File deletion requires explicit confirmation and removes object from bucket."""
        uploaded = self.manager.upload_file(
            file_content=b"Temporary staging file",
            filename="temp_stage.txt",
            category="documents",
        )

        # Unconfirmed delete must be rejected
        with self.assertRaises(StorageOperationError):
            self.manager.delete_object(uploaded.key, confirmed=False)

        # Object still exists
        self.assertEqual(len(self.manager.list_objects()), 1)

        # Confirmed delete succeeds
        deleted = self.manager.delete_object(uploaded.key, confirmed=True)
        self.assertTrue(deleted)
        self.assertEqual(len(self.manager.list_objects()), 0)

        # Subsequent download raises ObjectNotFoundError
        with self.assertRaises(ObjectNotFoundError):
            self.manager.download_file_bytes(uploaded.key)


if __name__ == "__main__":
    unittest.main()
