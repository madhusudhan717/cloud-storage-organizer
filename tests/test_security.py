"""
Automated security, access-control, pre-signed URL, and resilience tests:
5. Private object access denial for anonymous users.
6. Successful pre-signed URL access before expiration (without making object public).
7. Expired pre-signed URL rejection (both mocked timestamp and real HTTP time expiration).
10. Safe handling of invalid configuration, path traversal attempts, and connection failures.
"""

from __future__ import annotations

import sys
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from config import StorageConfig, StorageConfigError, mask_secret, sanitize_filename
from storage_manager import (
    AccessDeniedError,
    LocalS3CompatibleServer,
    StorageManager,
    StorageOperationError,
)


class TestSecurityAndAccessControls(unittest.TestCase):
    """Tests private-by-default policies, pre-signed URLs, expiration, and config safety."""

    server: LocalS3CompatibleServer
    config: StorageConfig
    manager: StorageManager

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = LocalS3CompatibleServer(
            access_key="sec_admin_key",
            secret_key="super_secret_signing_key_do_not_leak",
        )
        cls.config = StorageConfig(
            endpoint_url=cls.server.endpoint_url,
            access_key="sec_admin_key",
            secret_key="super_secret_signing_key_do_not_leak",
            bucket_name="private-vault-bucket",
            public_demo_bucket="isolated-public-sandbox",
            region="us-east-1",
            default_presigned_expiration=60,
        )
        cls.manager = StorageManager(config=cls.config, use_embedded_s3_client=True)
        cls.manager.ensure_buckets_exist()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.close()

    def setUp(self) -> None:
        with self.server.lock:
            self.server.buckets[self.config.bucket_name] = {}
            self.server.buckets[self.config.public_demo_bucket] = {}
            self.server.bucket_policies.clear()
        self.manager.disable_isolated_public_demo_mode()

    def test_05_private_object_access_denial_for_anonymous_users(self) -> None:
        """Test 5: Anonymous direct HTTP GET to a private object is strictly denied with HTTP 403."""
        secret_doc = b"CONFIDENTIAL: Zero-Trust Architecture Blueprint"
        uploaded = self.manager.upload_file(
            file_content=secret_doc,
            filename="zero_trust_blueprint.pdf",
            category="documents",
        )

        direct_url = self.manager.build_direct_object_url(uploaded.key)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(direct_url, timeout=3)

        self.assertEqual(ctx.exception.code, 403)

    def test_06_successful_presigned_url_access_keeps_object_private(self) -> None:
        """Test 6: Pre-signed URL grants temporary read access while direct anonymous URL remains 403."""
        content = b"Quarterly Security Posture Report - Authorized Bearer Read"
        uploaded = self.manager.upload_file(
            file_content=content,
            filename="q4_security_posture.txt",
            category="reports",
        )

        presigned = self.manager.generate_presigned_url(
            uploaded.key, expiration_seconds=60
        )
        self.assertTrue(presigned["object_remains_private"])
        self.assertEqual(presigned["expiration_seconds"], 60)

        # 1. Pre-signed URL succeeds with HTTP 200 and exact payload
        with urllib.request.urlopen(presigned["url"], timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), content)

        # 2. Direct unauthenticated URL to the exact same object MUST still be denied (403)
        direct_url = self.manager.build_direct_object_url(uploaded.key)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(direct_url, timeout=3)
        self.assertEqual(ctx.exception.code, 403)

        # 3. Tampering with the signature parameter is rejected with HTTP 403
        tampered_url = presigned["url"][:-6] + "000000"
        with self.assertRaises(urllib.error.HTTPError) as tampered_ctx:
            urllib.request.urlopen(tampered_url, timeout=3)
        self.assertEqual(tampered_ctx.exception.code, 403)

    def test_07_expired_presigned_url_rejection_mocked_and_real_time(self) -> None:
        """Test 7: Expired pre-signed URLs are rejected (both backdated timestamp and real wall-clock sleep)."""
        uploaded = self.manager.upload_file(
            file_content=b"Time-sensitive credentials audit",
            filename="ephemeral_audit.txt",
            category="reports",
        )

        # Part A: Backdated pre-signed URL (issued 10 minutes ago with 60s expiry)
        past_time = datetime.now(timezone.utc) - timedelta(minutes=10)
        expired_presigned = self.manager.generate_presigned_url(
            uploaded.key,
            expiration_seconds=60,
            issued_at_override=past_time,
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx_past:
            urllib.request.urlopen(expired_presigned["url"], timeout=3)
        self.assertEqual(ctx_past.exception.code, 403)

        # Part B: Live integration test with 1-second TTL against the local S3 service
        live_presigned = self.manager.generate_presigned_url(
            uploaded.key, expiration_seconds=1
        )
        # Immediately valid before expiry
        with urllib.request.urlopen(live_presigned["url"], timeout=3) as resp:
            self.assertEqual(resp.status, 200)

        # Wait for 1-second TTL to elapse
        time.sleep(1.25)

        # Must now be rejected with HTTP 403
        with self.assertRaises(urllib.error.HTTPError) as ctx_live:
            urllib.request.urlopen(live_presigned["url"], timeout=3)
        self.assertEqual(ctx_live.exception.code, 403)

    def test_isolated_public_demo_never_weakens_private_bucket(self) -> None:
        """Enabling public-read demo mode requires confirmation and only affects the sandbox bucket."""
        private_obj = self.manager.upload_file(
            b"Private main bucket data", "main_secret.txt", category="documents"
        )

        # Without explicit confirmation, enabling public demo mode raises AccessDeniedError
        with self.assertRaises(AccessDeniedError):
            self.manager.enable_isolated_public_demo_mode(explicit_confirmation=False)

        # Enable with confirmation
        state = self.manager.enable_isolated_public_demo_mode(explicit_confirmation=True)
        self.assertTrue(state["public_demo_enabled"])

        sandbox_obj = self.manager.upload_file(
            b"Public demo banner",
            "demo_banner.txt",
            category="images",
            use_public_demo_bucket=True,
        )

        # Sandbox object is readable anonymously
        sandbox_url = self.manager.build_direct_object_url(
            sandbox_obj.key, bucket_name=self.config.public_demo_bucket
        )
        with urllib.request.urlopen(sandbox_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"Public demo banner")

        # Main private bucket object MUST STILL deny anonymous access (403)
        private_url = self.manager.build_direct_object_url(private_obj.key)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(private_url, timeout=3)
        self.assertEqual(ctx.exception.code, 403)

    def test_10_safe_handling_of_invalid_config_path_traversal_and_connection_failure(self) -> None:
        """Test 10: Rejects path traversal, masks secrets, and safely handles connection failures."""
        # Path traversal attempts must raise StorageConfigError
        for malicious_name in ("../../../etc/passwd", "..\\windows\\system32\\cmd.exe", "/etc/shadow", ".env"):
            with self.assertRaises(StorageConfigError):
                sanitize_filename(malicious_name)

        # Secret masking never reveals secret key in repr or safe dict
        safe_dict = self.config.to_safe_dict()
        self.assertNotIn("super_secret_signing_key_do_not_leak", str(safe_dict))
        self.assertNotIn("super_secret_signing_key_do_not_leak", repr(self.config))
        self.assertEqual(mask_secret("abcd"), "****")

        # Invalid configuration parameters raise StorageConfigError
        with self.assertRaises(StorageConfigError):
            StorageConfig(
                endpoint_url="ftp://invalid-scheme",
                access_key="ak",
                secret_key="sk",
            ).validate()

        with self.assertRaises(StorageConfigError):
            StorageConfig(
                endpoint_url="http://localhost:9000",
                access_key="ak",
                secret_key="sk",
                bucket_name="same-bucket",
                public_demo_bucket="same-bucket",
            ).validate()

        # Unreachable endpoint handles connection failures gracefully without crashing or leaking secrets
        unreachable_cfg = StorageConfig(
            endpoint_url="http://127.0.0.1:59999",
            access_key="minioadmin",
            secret_key="top_secret_never_show_in_error",
            bucket_name="unreachable-bucket",
            public_demo_bucket="unreachable-sandbox",
        )
        unreachable_mgr = StorageManager(
            config=unreachable_cfg, use_embedded_s3_client=True
        )
        status = unreachable_mgr.check_connection()
        self.assertFalse(status["connected"])
        self.assertIsNotNone(status["error"])
        self.assertNotIn("top_secret_never_show_in_error", str(status["error"]))

        with self.assertRaises(StorageOperationError):
            unreachable_mgr.list_objects()


if __name__ == "__main__":
    unittest.main()
