# Deploy Drop Space to Vercel

This is the Vercel serverless adaptation of Drop Space. Vercel does not run the app's Dockerfile as a long-lived container; the Dockerfile remains for Docker-compatible hosts.

## Before deploying

1. Rotate any MongoDB credentials that were shown in screenshots or shared previously.
2. Push this folder to a private GitHub repository. Ensure `.env` is ignored and never committed.
3. Import the repository into Vercel.
4. Add these Project Environment Variables in Vercel (Production and Preview as needed):
   - `MONGODB_URI`: your rotated MongoDB Atlas connection string
   - `MONGODB_DB_NAME`: database name, e.g. `drop_space`
   - `OWNER_USERNAME`: optional initial owner username
   - `OWNER_PASSWORD`: optional strong initial owner password (at least 12 characters)
   - `COOKIE_SECURE`: `true`
   - `VERCEL`: `1` (Vercel normally sets this automatically)
5. In MongoDB Atlas Network Access, allow connections from Vercel. For a quick demo, Atlas can allow `0.0.0.0/0`, but that permits access attempts from any IP and must be paired with a strong database user/password. Prefer restricted networking if your plan/setup supports it.
6. Deploy from Vercel.

## Limitations

- This app uses MongoDB for persistent files and sessions; do not rely on local filesystem writes on Vercel.
- Vercel Functions have request/response payload limits. This version lowers the per-file upload cap to 4 MiB on Vercel; for larger files, use object storage such as Vercel Blob or S3 with direct uploads.
- Test registration, login, uploads, share links, expiry, and downloads on a preview deployment before sharing publicly.
- Set `COOKIE_SECURE=true` for HTTPS deployments.
