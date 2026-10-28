# Drop Space — Private File Sharing

A local-first one-off file transfer app. Owner credentials are configured in a private `.env` file. Application data, including uploaded file bytes, share-link metadata, sessions, and download counts, is persisted in MongoDB.

## Data flow

1. The owner signs in on the branded login page. The password is checked with Node.js scrypt; successful login creates an opaque, random, HTTP-only, same-site session whose hash and expiry are stored in MongoDB.
2. The owner selects or drops a file and chooses an expiry preset or custom date and time.
3. The server enforces a 10 MB file limit, a 50 MB total owner storage quota, and a rolling maximum of 20 successful uploads per hour.
4. The server validates the upload size and expiry, then saves the file bytes and metadata to MongoDB.
5. MongoDB stores the file bytes and metadata together. Share tokens are 256-bit random values with a unique index. Every share-page and download request checks expiry and revoke state on the server.
6. A successful download increments the count in MongoDB. The owner can copy a link, change its expiry, revoke it, or delete the file and its metadata.

Downloads are delivered as opaque attachments and are never executed or rendered by the app. The app does not scan uploads for malware.

## Configure

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. In `.env`, set `MONGODB_URI` to your MongoDB Atlas connection string and set `OWNER_PASSWORD` to a private passphrase of at least 12 characters. Configure the Atlas database user and network access list so this machine can connect.
4. Install the dependencies and start the app:

```powershell
npm install
npm start
```

Open `http://127.0.0.1:3000/login` and sign in with the username and password configured in `.env`. If port 3000 is occupied, set `PORT=3001` in `.env` and open `http://127.0.0.1:3001/login`.

Set `COOKIE_SECURE=true` only when serving the app over HTTPS.

## MongoDB collections

- `files` stores each file's binary data, owner, original safe filename, size, creation/expiry times, token, revoke state, and download count.
- `sessions` stores hashed session IDs and their expiry. MongoDB removes expired sessions with a TTL index.
- `app_control` records one-time migration status.

The app does not silently fall back to local storage. New uploads and state changes are acknowledged only after MongoDB writes complete.

## Existing local uploads

On first startup, the app imports the old local `data/metadata.json` and matching files from `data/files/` into MongoDB, once per database. It leaves the old local files untouched as a backup. After confirming the imported files and links in the dashboard, you can archive or delete the old local `data/` folder.

## Features and limits

- Owner-only login with scrypt password verification, an eight-hour HttpOnly/SameSite session, logout, and five failed login attempts per 15 minutes.
- 10 MB maximum per upload; 50 MB total owner quota; 20 successful uploads in a rolling hour.
- Expiry presets from 1 hour to 7 days and custom expiry from 1 minute up to 30 days.
- Owner can edit the expiry of an existing non-revoked share; the selected time is interpreted in the browser's local timezone and saved as UTC.
- Dashboard timestamps show the browser's timezone, while MongoDB Compass displays stored dates in UTC.
- One-off share page, attachment download, live download count, revoke, delete, filename search, and quota meter.
- Files are stored and delivered as downloads; this demo does not include malware scanning.

## Demo checklist

1. Sign in, upload a small file, and create a share link.
2. Copy the share link and download it in a private browser window.
3. Refresh the dashboard and confirm the download count increments.
4. Revoke the link and confirm the recipient gets a revoked message.
5. Create a custom expiry and verify the link expires at the selected time.
6. Restart the server and confirm files and metadata remain available from MongoDB.

## Added features

- Account creation and sign-in. Usernames are unique; passwords are stored as salted scrypt hashes.
- Separate workspace tabs for uploading, viewing your files, and opening a pasted Drop Space share link.
- Docker image support for container hosts.

## Run locally

1. Copy `.env.example` to `.env` and fill in your MongoDB Atlas URI and a strong `OWNER_PASSWORD` (12+ characters).
2. Run `npm install`.
3. Run `npm start` and open `http://localhost:3000`.

New accounts are stored in the MongoDB `users` collection. Each account sees and manages only its own uploads.

## Docker

Build and run:

```sh
docker build -t drop-space .
docker run --rm -p 3000:3000 --env-file .env drop-space
```

## Hosting note: Vercel vs Docker

Vercel does not run an arbitrary long-lived Docker container from a `Dockerfile`; this app currently uses a Node HTTP server and streamed multipart uploads, so the Dockerfile is intended for a container host (for example, Railway, Render, or a VPS). To deploy on Vercel, the server needs a separate serverless/Node-functions adaptation and uploads/storage should be moved to a service designed for serverless deployments (for example, object storage). Do not treat a successful Docker build as a Vercel deployment.
