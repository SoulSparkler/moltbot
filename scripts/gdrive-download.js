#!/usr/bin/env node
/**
 * Google Drive download helper for Clawbrowser
 * Downloads files from Google Drive to local storage for upload to social platforms
 *
 * Usage: node gdrive-download.js <fileId> <outputPath>
 * Example: node gdrive-download.js 1abc123def456 /data/workspace/image.jpg
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

// Environment variables for Google Drive authentication
// Set these in Railway:
// - GOOGLE_DRIVE_CLIENT_ID
// - GOOGLE_DRIVE_CLIENT_SECRET
// - GOOGLE_DRIVE_REFRESH_TOKEN
// Or use a service account JSON key:
// - GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (base64 encoded)

async function downloadFile(fileId, outputPath) {
  try {
    let auth;

    // Option 1: Service account (recommended for Railway)
    if (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON) {
      const serviceAccountKey = JSON.parse(
        Buffer.from(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf-8')
      );
      auth = new google.auth.GoogleAuth({
        credentials: serviceAccountKey,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
    }
    // Option 2: OAuth2 (requires refresh token)
    else if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_DRIVE_CLIENT_ID,
        process.env.GOOGLE_DRIVE_CLIENT_SECRET,
        'urn:ietf:wg:oauth:2.0:oob'
      );
      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
      });
      auth = oauth2Client;
    }
    // Option 3: Application Default Credentials (ADC)
    else {
      auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
    }

    const drive = google.drive({ version: 'v3', auth });

    // Get file metadata to check if it exists and get MIME type
    const file = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size',
    });

    console.log(`Downloading: ${file.data.name} (${file.data.mimeType})`);
    console.log(`Size: ${(file.data.size / 1024 / 1024).toFixed(2)} MB`);

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Download file
    const dest = fs.createWriteStream(outputPath);
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      response.data
        .on('end', () => {
          console.log(`✅ Downloaded to: ${outputPath}`);
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ Error downloading file:', err);
          reject(err);
        })
        .pipe(dest);
    });
  } catch (error) {
    console.error('❌ Failed to download file:', error.message);
    if (error.code === 404) {
      console.error('File not found. Check the file ID and sharing permissions.');
    } else if (error.code === 403) {
      console.error('Permission denied. Ensure the file is shared with the service account or authenticated user.');
    }
    process.exit(1);
  }
}

// CLI usage
if (process.argv.length < 4) {
  console.error('Usage: node gdrive-download.js <fileId> <outputPath>');
  console.error('Example: node gdrive-download.js 1abc123def456 /data/workspace/image.jpg');
  process.exit(1);
}

const fileId = process.argv[2];
const outputPath = process.argv[3];

downloadFile(fileId, outputPath);
