#!/bin/bash

# Kill existing screen sessions if they are running
if screen -ls | grep -q "backend"; then
    echo "Found existing 'backend' screen session. Interrupting process and terminating..."
    screen -S backend -X stuff $'\003' # Send Ctrl-C to interrupt the process
    screen -X -S backend quit
fi

if screen -ls | grep -q "frontend"; then
    echo "Found existing 'frontend' screen session. Interrupting process and terminating..."
    screen -S frontend -X stuff $'\003' # Send Ctrl-C to interrupt the process
    screen -X -S frontend quit
fi


# 1. Start the backend service in a screen session
echo "Starting Backend service in a screen session named 'backend'..."
screen -S backend -d -m python3 backend/main.py --project_id=visionai-testing-stable --location=us-central1 

# 2. Start the frontend service in another screen session
echo "Starting Frontend HTTP server in a screen session named 'frontend'..."
# We use bash -c to execute the two commands inside the screen session.
# Note the backslash before $PORT to ensure it's evaluated when the screen command runs.
screen -S frontend -d -m bash -c "cd frontend && python3 -m http.server $PORT"

echo ""
echo "Backend and Frontend services are starting in separate screen sessions."
echo "You can check their status with 'screen -ls'."
echo "To attach to a session, use 'screen -r backend' or 'screen -r frontend'."
echo "To stop a service, attach to the screen and press Ctrl+C, or use 'screen -X -S <session_name> quit'."