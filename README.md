# Cloud Storage Organizer

A web-based file management application built with **React, Vite, Node.js, Express, and Amazon S3**. It lets users upload, organize, search, tag, download, delete, and temporarily share files while keeping objects private in S3 by default.

**Live application:** https://cloud-storage-organizer-madhu.onrender.com  
**Username:** madhusudhan717
**Password:** madhu123
**GitHub repository:** https://github.com/madhusudhan717/cloud-storage-organizer

> **Current deployment:** The main application is the React/Vite dashboard served by the Express application. Render hosts the dashboard and API in one web service; Amazon S3 stores uploaded files. A separate Vercel deployment is not required for this architecture.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Run locally](#run-locally)
- [Environment variables](#environment-variables)
- [AWS S3 setup](#aws-s3-setup)
- [Application workflow](#application-workflow)
- [API endpoints](#api-endpoints)
- [Deploy to Render](#deploy-to-render)
- [Security notes](#security-notes)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Legacy Python/MinIO files](#legacy-pythonminio-files)

---

## Features

- **File dashboard:** Overview of stored objects, storage usage, and category counts.
- **Upload files:** Upload files from the browser to a private S3 bucket.
- **Category prefixes:** Organize objects using prefixes such as `documents/`, `images/`, `reports/`, and `projects/`.
- **Search and filtering:** Search object names and filter by category.
- **Metadata:** Store object metadata such as department, owner, and description.
- **Object tags:** Add and update S3 object tags. Amazon S3 supports up to 10 tags per object.
- **Download and delete:** Download an object through the backend or delete it after explicit confirmation.
- **Temporary sharing:** Generate AWS Signature Version 4 pre-signed `GetObject` URLs with an expiry from 1 second to 7 days. The dashboard offers common durations such as 60 seconds, 5 minutes, and 15 minutes.
- **Private by default:** Objects remain private; the application does not enable public bucket access.
- **Application protection:** Optional HTTP Basic Authentication locally; username and password are required when `NODE_ENV=production`.
- **Health endpoint:** `/health` is available for Render health checks.

The public-demo bucket workflow from the earlier MinIO prototype is disabled in the AWS deployment. Uploads and object operations target the one configured private S3 bucket.

---

## Architecture

```text
                      Browser
                         |
                         v
             React + Vite Dashboard
                         |
                         | same-origin /api requests
                         v
             Node.js + Express Server
             - HTTP Basic Authentication
             - File validation and categories
             - Metadata and object tags
             - Pre-signed URL generation (AWS SigV4)
                         |
                         | AWS SDK for JavaScript v3
                         v
                 Amazon S3 Bucket
                 - Private objects
                 - Server-side encryption (AES256)
                 - Object metadata and tags

     Render Web Service hosts the React build and Express API
```

### File storage flow

1. The browser reads a selected file and sends its content to the Express upload endpoint as Base64-encoded JSON.
2. Express validates the filename and category, normalizes metadata and tags, and sends a `PutObject` request to Amazon S3.
3. S3 stores the object under a category prefix, for example `documents/report.pdf`.
4. The application lists object details from S3. It does not use an in-memory file map as the persistent storage layer.
5. For temporary sharing, Express creates a genuine AWS Signature Version 4 pre-signed URL for the selected object.

---

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Styling and icons | Tailwind CSS, Lucide React |
| Backend | Node.js, Express, TypeScript (`tsx`) |
| Object storage | Amazon S3 |
| AWS integration | AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`) |
| Pre-signed URLs | `@aws-sdk/s3-request-presigner` |
| Environment configuration | `dotenv` |
| Source control | Git and GitHub |
| Hosting | Render Web Service |

---

## Project structure

```text
cloud-storage-organizer/
├── src/
│   ├── App.tsx               # Main React dashboard and user interface
│   ├── main.tsx              # React application entry point
│   └── index.css             # Global styles
├── storage/                  # Local storage directory used by legacy Python files
├── tests/                    # Python unittest files from the earlier prototype
├── app.py                    # Legacy Streamlit prototype
├── config.py                # Legacy Python/MinIO configuration
├── storage_manager.py       # Legacy Python S3-compatible storage manager
├── requirements.txt         # Python prototype dependencies
├── docker-compose.yml       # Local MinIO setup for the Python prototype
├── server.ts                # Express API and production static-file server
├── index.html               # Vite HTML entry point
├── vite.config.ts           # Vite configuration
├── tsconfig.json            # TypeScript configuration
├── package.json             # Node.js scripts and dependencies
├── package-lock.json        # Locked npm dependency tree
├── .env.example             # Safe environment-variable template
├── .gitignore               # Excludes local secrets and generated files
└── README.md
```

The primary deployed web application uses `src/`, `server.ts`, and the Node.js dependencies. The Python and MinIO files are retained from the earlier prototype; see [Legacy Python/MinIO files](#legacy-pythonminio-files).

---

## Prerequisites

- Node.js 22 LTS (or another Node.js release supported by the installed Vite version)
- npm
- Git
- An AWS account with an S3 bucket
- An IAM identity with permissions limited to the application bucket

---

## Run locally

### 1. Clone the repository

```bash
git clone https://github.com/madhusudhan717/cloud-storage-organizer.git
cd cloud-storage-organizer
```

### 2. Install Node.js dependencies

```bash
npm install
```

### 3. Create the local environment file

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env
notepad .env
```

**macOS / Linux:**

```bash
cp .env.example .env
```

Edit `.env` and add your own AWS credentials and application login values. Do not commit this file.

### 4. Start the development server

```bash
npm run dev
```

Open http://localhost:3000.

### 5. Run checks

```bash
npm run lint
npm run build
```

To run the built frontend through the Express production path locally, build first and set the production environment. Production mode requires `APP_USERNAME` and `APP_PASSWORD`.

**Windows PowerShell:**

```powershell
npm run build
$env:NODE_ENV = "production"
npm start
```

**macOS / Linux:**

```bash
npm run build
NODE_ENV=production npm start
```

---

## Environment variables

Use real values in your local `.env` file and in the Render service's Environment settings. Keep `.env.example` as a template containing placeholders only.

| Variable | Required | Description |
|---|---:|---|
| `AWS_ACCESS_KEY_ID` | Yes, unless using an AWS runtime role | IAM access key ID used by the backend |
| `AWS_SECRET_ACCESS_KEY` | Yes, unless using an AWS runtime role | Matching IAM secret access key |
| `AWS_REGION` | Yes | Region containing the bucket, for example `ap-southeast-2` |
| `S3_BUCKET_NAME` | Yes | Name of the private S3 bucket |
| `DEFAULT_PRESIGNED_EXPIRATION` | No | Default pre-signed URL lifetime in seconds; default is `300` |
| `APP_USERNAME` | Required in production | HTTP Basic Authentication username |
| `APP_PASSWORD` | Required in production | Strong, unique HTTP Basic Authentication password |
| `NODE_ENV` | Set to `production` on Render | Makes Express serve the built `dist/` frontend |
| `PORT` | Provided by Render | Port on which the Express server listens |
| `CORS_ORIGIN` | Optional | Comma-separated allowed browser origins if the frontend is hosted on a different origin |

### Example `.env.example`

```env
# AWS S3 (replace placeholders in your local .env only)
AWS_ACCESS_KEY_ID=replace-with-your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-your-aws-secret-access-key
AWS_REGION=ap-southeast-2
S3_BUCKET_NAME=replace-with-your-s3-bucket-name
DEFAULT_PRESIGNED_EXPIRATION=300

# Local application authentication (set both values together)
APP_USERNAME=replace-with-your-local-username
APP_PASSWORD=replace-with-a-strong-local-password

# Optional when using a separate frontend origin
# CORS_ORIGIN=https://your-frontend.example.com
```

> Never paste real AWS keys, Gemini keys, passwords, or pre-signed URLs into README files, source code, screenshots, or Git commits. The `.gitignore` file excludes `.env`; verify with `git check-ignore .env` before committing.

---

## AWS S3 setup

### 1. Create a bucket

Create an S3 general purpose bucket in your chosen AWS region. This deployment uses the bucket configured in `S3_BUCKET_NAME` and the region configured in `AWS_REGION`.

Recommended bucket settings:

- Keep **Block all public access** enabled.
- Use **Bucket owner enforced** object ownership (ACLs disabled).
- Enable default server-side encryption. The application also specifies `AES256` on object uploads and metadata-replacement copies.
- Do not add a public-read bucket policy for this application.

### 2. Create an IAM identity with least privilege

Attach a policy scoped to the application's bucket. Replace `YOUR_BUCKET_NAME` with the exact bucket name:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
    }
  ]
}
```

Create access keys for the backend only when needed. Never use root-account access keys in the application. Rotate keys immediately if they are exposed.

### 3. Configure S3 CORS for browser-side pre-signed URL testing

The dashboard's link-verification action uses browser `fetch()` against the S3 pre-signed URL. For that browser-based check, configure S3 CORS to allow the exact origin from which the dashboard is opened. Example for local and Render use:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": [
      "http://localhost:3000",
      "https://cloud-storage-organizer-madhu.onrender.com"
    ],
    "ExposeHeaders": ["ETag", "Content-Type", "Content-Length"],
    "MaxAgeSeconds": 3000
  }
]
```

CORS controls which browser origins may read responses; it does **not** make the bucket or objects public. A valid pre-signed URL is still required to retrieve a private object.

---

## Application workflow

1. Open **My Files** to view objects stored in the configured S3 bucket.
2. Choose **Upload Files** and select a file.
3. Select a category such as Documents, Images, Reports, or Projects.
4. Add optional metadata and object tags.
5. Upload. The backend stores the object under the selected category prefix in S3.
6. Select an object to view its details, update tags/metadata, download it, or delete it after confirmation.
7. Open **Shared & Temporary Links**, select a private object, choose an expiry, and generate a pre-signed URL.
8. Share the generated URL only with the intended recipient. Anyone who possesses a valid URL can access that object until the URL expires.

### Object key examples

```text
documents/budget.pdf
images/site-photo.png
reports/monthly-summary.csv
projects/design-notes.txt
```

The application sanitizes filenames and rejects path traversal patterns. Uploaded object metadata and tags are stored in S3, not only in browser memory.

---

## API endpoints

All routes except `GET /health` are protected by HTTP Basic Authentication when `APP_USERNAME` and `APP_PASSWORD` are configured. In production, the server refuses to start unless both are set.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Public health check for Render |
| `GET` | `/api/storage/status` | Checks bucket access and returns storage statistics |
| `GET` | `/api/storage/objects` | Lists objects; supports `category` and `search` query parameters |
| `POST` | `/api/storage/upload` | Uploads a Base64-encoded file with metadata and tags |
| `PUT` | `/api/storage/tags` | Updates object metadata and tags |
| `GET` | `/api/storage/download` | Downloads an object using `bucket` and `key` query parameters |
| `DELETE` | `/api/storage/object` | Deletes an object; requires `confirmed: true` |
| `PUT` | `/api/storage/settings` | Updates default pre-signed URL expiry |
| `GET` | `/api/storage/presigned-links` | Lists links generated during the current server process |
| `POST` | `/api/storage/presign` | Generates an AWS S3 pre-signed download URL |
| `POST` | `/api/storage/public-demo` | Returns `403`; public-demo mode is disabled |
| `POST` | `/api/tests/run` | Runs the repository's Python unittest suite if Python is installed in the runtime |
| `GET` | `/api/project-files` | Returns selected project source files for the dashboard inspector |
| `GET` | `/s3/:bucket/*` | Rejects anonymous direct object access with `403` |

### Upload request example

The upload endpoint expects JSON similar to:

```json
{
  "filename": "monthly-summary.csv",
  "category": "reports",
  "contentType": "text/csv",
  "contentBase64": "BASE64_ENCODED_FILE_CONTENT",
  "metadata": {
    "department": "Finance",
    "owner": "Finance Team",
    "description": "Monthly report"
  },
  "tags": {
    "Category": "Report",
    "Type": "Monthly"
  }
}
```

The Express JSON parser is configured with a 40 MB request-body limit. Because file contents are Base64-encoded inside JSON, the maximum usable file size is lower than 40 MB.

---

## Deploy to Render

The repository is configured for one Render Web Service that serves both the React build and Express API.

1. Push the project to the `main` branch of GitHub.
2. In the Render dashboard, choose **New + → Web Service**.
3. Connect the repository `madhusudhan717/cloud-storage-organizer`.
4. Configure the service:

   | Setting | Value |
   |---|---|
   | Runtime | Node |
   | Branch | `main` |
   | Root directory | Leave blank |
   | Build command | `npm install && npm run build` |
   | Start command | `npm start` |
   | Health check path | `/health` |

5. Add the following environment variables in Render. Use real secret values in Render's dashboard; do not commit them.

   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `AWS_ACCESS_KEY_ID` | Your IAM access key ID |
   | `AWS_SECRET_ACCESS_KEY` | Your IAM secret access key |
   | `AWS_REGION` | Your bucket's region |
   | `S3_BUCKET_NAME` | Your bucket's name |
   | `DEFAULT_PRESIGNED_EXPIRATION` | `300` |
   | `APP_USERNAME` | Your chosen application username |
   | `APP_PASSWORD` | Your strong application password |

6. Create the service and wait for the deployment to become **Live**.
7. Check `https://YOUR-RENDER-SERVICE.onrender.com/health` and confirm it returns `{ "status": "ok" }`.
8. Open the service URL, authenticate, and test upload, listing, download, deletion, and pre-signed sharing.

Render supplies the `PORT` environment variable. The Express server listens on `process.env.PORT` and serves the built `dist/` directory when `NODE_ENV=production`.

---

## Security notes

- **Keep the S3 bucket private.** Do not disable S3 Block Public Access for this application.
- **Use least-privilege IAM permissions.** Limit the IAM policy to the one application bucket.
- **Protect the dashboard.** Configure both `APP_USERNAME` and `APP_PASSWORD`; the production server requires them.
- **Protect secrets.** Store credentials in local `.env` and Render Environment Variables. Never commit `.env` or real secrets to GitHub.
- **Treat pre-signed URLs as bearer credentials.** Anyone with a valid URL can access its object until expiry. Use short expiry periods and share links carefully.
- **Keep dependencies current.** Review `npm audit` and update packages deliberately.
- **Use HTTPS in production.** Render provides the public HTTPS service URL.
- **Public demo is disabled.** The AWS deployment rejects public-demo bucket operations and does not grant public object access.

HTTP Basic Authentication is a simple application-wide gate, not a multi-user identity system. Use a proper identity provider and session-based authorization if the application is expanded for multiple users or sensitive production workloads.

---

## Testing

### Node.js application checks

```bash
npm run lint
npm run build
```

### Verify the health endpoint

```bash
curl https://YOUR-RENDER-SERVICE.onrender.com/health
```

Expected response:

```json
{"status":"ok"}
```

### Verify S3 from the dashboard

- Confirm the dashboard reports **Storage Connected**.
- Upload a small test file.
- Confirm the object appears in the configured S3 bucket under its category prefix.
- Download the file and confirm it opens.
- Generate a short-lived pre-signed URL and test it before expiry.
- Confirm an anonymous direct object request is denied.

The **Automated Tests** screen invokes the Python unittest suite using `python`/`python3`. That endpoint requires Python and the test dependencies to be installed in the runtime. The Render web service is deployed as a Node.js service, so the Python test runner may not be available there; run the Python tests in a configured local Python environment if needed.

---

## Troubleshooting

| Symptom | Checks |
|---|---|
| `503` from `/api/storage/status` | Check `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `S3_BUCKET_NAME` in the active environment. Confirm the IAM policy allows `s3:ListBucket` and object read permissions. |
| `AccessDenied` | Confirm the IAM policy is attached to the correct IAM user and scoped to the correct bucket ARN. |
| `InvalidAccessKeyId` or `SignatureDoesNotMatch` | Replace incorrect or expired credentials; ensure the access key and secret belong together. |
| `ECONNREFUSED` or `ETIMEDOUT` | Remove old MinIO endpoint overrides such as `S3_ENDPOINT_URL=http://localhost:9000` and `AWS_ENDPOINT_URL`. The AWS SDK should use the standard regional AWS endpoint. Check outbound network access. |
| `401 Authentication required` | Enter the `APP_USERNAME` and `APP_PASSWORD` configured in Render. |
| Dashboard fails to load | Check the Render deployment logs, confirm the build succeeded, and verify `NODE_ENV=production`. |
| Pre-signed URL verification shows `Failed to fetch` | Check the S3 bucket CORS configuration and allow the exact website origin. Also ensure the URL has not expired. |
| Pre-signed URL returns `403` | Generate a fresh URL, verify the object exists, and check the IAM principal's `s3:GetObject` permission and system clock. |
| Uploaded object is missing | Check the selected category prefix and the configured bucket/region in the Render environment. |

---

## Legacy Python/MinIO files

This repository also retains Python files (`app.py`, `config.py`, `storage_manager.py`, `requirements.txt`, `tests/`, and `docker-compose.yml`) from an earlier Streamlit + MinIO prototype. They are not the primary frontend/backend used by the current Render deployment.

For that earlier prototype, the repository includes a Docker Compose MinIO setup and a Python requirements file. Its environment-variable names and run instructions differ from the current Node.js/AWS S3 web application. Do not use the old MinIO example values when configuring the deployed Node.js service.

---

## License

Add your project's chosen license here before distributing or reusing the code. No license is declared in this README.

## Output
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/a4ddc07d-a028-4530-808e-66fdd94377d0" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/8143309f-d191-46ab-bc19-c1ebc3f19e13" />


