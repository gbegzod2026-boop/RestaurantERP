// db.js — Firebase Realtime Database connection
import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase, ref, connectDatabaseEmulator } from "firebase/database";
import dotenv from "dotenv";

dotenv.config();

const firebaseConfig = {
  apiKey:            process.env.FIREBASE_API_KEY,
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL:       process.env.FIREBASE_DATABASE_URL,
  projectId:         process.env.FIREBASE_PROJECT_ID,
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.FIREBASE_APP_ID,
};

let _app = null;
let _db  = null;
let _connected = false;

export async function connectDB() {
  try {
    _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    _db  = getDatabase(_app);
    _connected = true;
    console.log("✅ Firebase Realtime Database connected");
    return _db;
  } catch (err) {
    _connected = false;
    console.error("❌ Firebase connection error:", err.message);
    return null;
  }
}

export function getDB() {
  return _db;
}

export function isDatabaseConnected() {
  return _connected && !!_db;
}

export function getDatabaseState() {
  if (_connected && _db) return "connected";
  if (_db && !_connected)  return "connecting";
  return "disconnected";
}