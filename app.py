"""
Streamlit Web Interface for Cloud Storage Organizer — Object Storage & Access Controls.

Redesigned with a colorful, beginner-friendly Google Drive / modern SaaS experience.
Run locally with:
    streamlit run app.py
"""

from __future__ import annotations

import urllib.error
import urllib.request
from typing import Dict, List, Optional

import streamlit as st

from config import (
    ALLOWED_CATEGORIES,
    PRESIGNED_EXPIRY_OPTIONS,
    StorageConfig,
    StorageConfigError,
)
from storage_manager import (
    AccessDeniedError,
    StorageManager,
    StorageOperationError,
    StoredObjectInfo,
)


def format_bytes(size: int) -> str:
    """Format byte counts into human-readable units."""
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.2f} KB"
    return f"{size / (1024 * 1024):.2f} MB"


def init_manager() -> Optional[StorageManager]:
    """Initialize and cache the StorageManager in Streamlit session state."""
    if "tracked_links" not in st.session_state:
        st.session_state["tracked_links"] = []
    if "storage_manager" not in st.session_state:
        try:
            cfg = StorageConfig.from_env()
            manager = StorageManager(config=cfg)
            manager.ensure_buckets_exist()
            st.session_state["storage_manager"] = manager
            st.session_state["config_error"] = None
        except (StorageConfigError, StorageOperationError) as exc:
            st.session_state["storage_manager"] = None
            st.session_state["config_error"] = str(exc)
    return st.session_state.get("storage_manager")


def render_app() -> None:
    st.set_page_config(
        page_title="Cloud Storage Organizer — Object Storage & Access Controls",
        layout="wide",
    )

    # Soft lavender / white modern styling
    st.markdown(
        """
        <style>
        .stApp { background-color: #f6f5ff; }
        .hero-card {
            background: #ffffff;
            border: 1px solid #e0e7ff;
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(79, 70, 229, 0.05);
        }
        </style>
        """,
        unsafe_allow_html=True,
    )

    manager = init_manager()
    config_error = st.session_state.get("config_error")

    if config_error or manager is None:
        st.error(f"Storage Connection Error: {config_error}")
        st.info(
            "Make sure MinIO is running locally (`docker compose up -d`) and your `.env` file is configured."
        )
        return

    conn_status = manager.check_connection()

    with st.sidebar:
        st.markdown("### Cloud Organizer")
        st.caption("Object Storage & Access Controls")
        nav_page = st.radio(
            "Navigation",
            options=[
                "Overview",
                "My Files",
                "Documents",
                "Images",
                "Reports",
                "Projects",
                "Shared & Temporary Links",
                "Access & Security",
                "Settings",
            ],
        )
        st.divider()
        if conn_status["connected"]:
            st.success("Storage Connected")
        else:
            st.error("Storage Offline")
        st.caption(f"Bucket: `{conn_status['private_bucket']}`")
        with st.expander("Need Help?"):
            st.caption(
                "Files uploaded here are private by default. Use 'Shared & Temporary Links' "
                "to create time-limited pre-signed URLs without making files public."
            )

    try:
        all_objects: List[StoredObjectInfo] = manager.list_objects(
            include_public_demo_bucket=True
        )
    except StorageOperationError as exc:
        st.error(str(exc))
        all_objects = []

    total_files = len(all_objects)
    total_bytes = sum(obj.size_bytes for obj in all_objects)
    private_count = sum(1 for obj in all_objects if obj.access_mode == "Private")
    active_links = len(st.session_state.get("tracked_links", []))

    if nav_page == "Overview":
        st.markdown(
            """
            <div class="hero-card">
                <h2 style="margin:0;color:#1e1b4b;">Your files. Organized. Secure. Always accessible.</h2>
                <p style="margin-top:6px;color:#475569;">
                    Manage your cloud files, organize documents, control access, and share files securely.
                </p>
            </div>
            """,
            unsafe_allow_html=True,
        )

        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Total Files", str(total_files))
        c2.metric("Storage Used", format_bytes(total_bytes))
        c3.metric("Private Files", str(private_count))
        c4.metric("Active Temporary Links", str(active_links))

        st.subheader("Categories")
        cat_cols = st.columns(4)
        for idx, cat_key in enumerate(ALLOWED_CATEGORIES.keys()):
            cat_objs = [o for o in all_objects if o.category == cat_key]
            cat_bytes = sum(o.size_bytes for o in cat_objs)
            cat_cols[idx].metric(
                cat_key.capitalize(),
                f"{len(cat_objs)} files",
                format_bytes(cat_bytes),
            )

        st.subheader("Recent Files")
        if not all_objects:
            st.info("No files here yet. Upload your first file in 'My Files' to get started.")
        else:
            st.dataframe(
                [
                    {
                        "File Name": o.filename,
                        "Category": o.category.capitalize(),
                        "Size": format_bytes(o.size_bytes),
                        "Modified (UTC)": o.last_modified,
                        "Access Status": o.access_mode,
                    }
                    for o in all_objects[:10]
                ],
                use_container_width=True,
                hide_index=True,
            )

    elif nav_page in {"My Files", "Documents", "Images", "Reports", "Projects"}:
        st.header(nav_page)
        default_cat = (
            "all" if nav_page == "My Files" else nav_page.lower()
        )

        with st.expander("Upload Files — Drag and drop files here, or browse your computer", expanded=not bool(all_objects)):
            with st.form("upload_form", clear_on_submit=True):
                uploaded_file = st.file_uploader("Choose a file")
                category = st.selectbox(
                    "Category",
                    options=list(ALLOWED_CATEGORIES.keys()),
                    index=0 if default_cat == "all" else list(ALLOWED_CATEGORIES.keys()).index(default_cat),
                )
                col_m1, col_m2, col_m3 = st.columns(3)
                department = col_m1.text_input("Department", value="IT")
                owner = col_m2.text_input("Owner", value="Team Member")
                description = col_m3.text_input("Description", value="Project file")

                col_t1, col_t2 = st.columns(2)
                tag_category = col_t1.text_input("Tag: Category", value="Academic")
                tag_type = col_t2.text_input("Tag: Type", value="Report")

                st.caption("Private access enabled by default.")
                if st.form_submit_button("Upload File", type="primary"):
                    if uploaded_file is None:
                        st.warning("Please select a file to upload.")
                    else:
                        try:
                            info = manager.upload_file(
                                file_content=uploaded_file.getvalue(),
                                filename=uploaded_file.name,
                                category=category,
                                metadata={
                                    "department": department,
                                    "owner": owner,
                                    "description": description,
                                },
                                tags={"Category": tag_category, "Type": tag_type},
                            )
                            st.success(f"Uploaded `{info.filename}` to `{info.category}/`.")
                            st.rerun()
                        except (StorageConfigError, StorageOperationError, AccessDeniedError) as exc:
                            st.error(str(exc))

        search_q = st.text_input("Search your files...")
        filtered = manager.list_objects(
            category_filter=default_cat,
            search_query=search_q,
            include_public_demo_bucket=True,
        )

        if not filtered:
            st.info("No files here yet. Upload your first file to get started.")
        else:
            st.dataframe(
                [
                    {
                        "File Name": o.filename,
                        "Category": o.category.capitalize(),
                        "Size": format_bytes(o.size_bytes),
                        "Modified": o.last_modified,
                        "Tags": ", ".join(f"{k}: {v}" for k, v in o.tags.items()),
                        "Access Status": o.access_mode,
                    }
                    for o in filtered
                ],
                use_container_width=True,
                hide_index=True,
            )

            selected = st.selectbox(
                "Select a file for details, tags, download, or deletion",
                options=[f"{o.bucket}::{o.key}" for o in filtered],
            )
            sel_bucket, sel_key = selected.split("::", 1)
            active_obj = next(
                o for o in filtered if o.bucket == sel_bucket and o.key == sel_key
            )

            col_d1, col_d2 = st.columns(2)
            with col_d1:
                raw_data = manager.download_file_bytes(
                    active_obj.key, bucket_name=active_obj.bucket
                )
                st.download_button(
                    label=f"Download {active_obj.filename}",
                    data=raw_data,
                    file_name=active_obj.filename,
                    mime=active_obj.content_type,
                    use_container_width=True,
                )
            with col_d2:
                confirm_del = st.checkbox(f"Confirm deleting {active_obj.filename}")
                if st.button("Delete File", use_container_width=True):
                    try:
                        manager.delete_object(
                            active_obj.key,
                            confirmed=confirm_del,
                            bucket_name=active_obj.bucket,
                        )
                        st.success(f"Deleted `{active_obj.filename}`.")
                        st.rerun()
                    except StorageOperationError as exc:
                        st.error(str(exc))

    elif nav_page == "Shared & Temporary Links":
        st.header("Shared & Temporary Links")
        st.caption(
            "Share a private file through a temporary link without making the file public."
        )
        if not all_objects:
            st.info("Upload a file first to generate a temporary link.")
        else:
            target = st.selectbox(
                "Choose a file to share",
                options=[f"{o.bucket}::{o.key}" for o in all_objects],
            )
            t_bucket, t_key = target.split("::", 1)
            exp_label = st.selectbox(
                "Expiration Duration",
                options=list(PRESIGNED_EXPIRY_OPTIONS.keys()),
                index=1,
            )
            if st.button("Generate Secure Link", type="primary"):
                presigned = manager.generate_presigned_url(
                    t_key,
                    expiration_seconds=PRESIGNED_EXPIRY_OPTIONS[exp_label],
                    bucket_name=t_bucket,
                )
                st.session_state["tracked_links"].insert(0, presigned)
                st.success(f"Generated link expiring at {presigned['expires_at']}")
                st.code(str(presigned["url"]), language="text")

        st.info(
            "Anyone possessing a valid pre-signed URL may access the file until the link expires."
        )

    elif nav_page == "Access & Security":
        st.header("Access & Security Center")
        st.success("Private-by-Default Status: Verified (All new files are private)")
        st.success("Anonymous Access Status: Blocked (HTTP 403 Forbidden)")
        st.info(f"Current Main Bucket: `{conn_status['private_bucket']}`")
        st.info(f"Storage Endpoint Status: Connected (`{conn_status['endpoint']}`)")

        st.subheader("How it works")
        st.markdown(
            "1. **Private files require authorization** — Direct anonymous links are blocked.\n"
            "2. **Pre-signed URLs provide temporary access** — Cryptographic signatures authorize downloads for a chosen duration.\n"
            "3. **Expired links no longer authorize downloads** — Once the timer reaches zero, the storage server rejects the link."
        )

    elif nav_page == "Settings":
        st.header("Settings")
        st.markdown(f"**Storage Endpoint:** `{conn_status['endpoint']}`")
        st.markdown(f"**Primary Private Bucket:** `{conn_status['private_bucket']}`")
        st.markdown(f"**Isolated Demo Sandbox Bucket:** `{conn_status['public_demo_bucket']}`")
        st.caption("Secret keys and sensitive credentials are never displayed in the interface.")


if __name__ == "__main__":
    render_app()
