#!/bin/bash

# 1. Start the backend service and send it to the background
echo "Starting Backend service on ports 8081 (POST) and 8080 (WS)..."
python3 backend/main.py &  # <-- The ampersand (&) is key!

# 2. Start the frontend service
echo "Starting Frontend HTTP server on Cloud Run's required port ($PORT)..."
cd frontend
python3 -m http.server $PORT # <-- This is the main blocking process