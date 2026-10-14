#!/bin/bash

PORT=8000

PIDS=$(lsof -ti :$PORT)

if [ -n "$PIDS" ]; then
    echo "Killing processes using port $PORT: $PIDS"
    kill -9 $PIDS
fi

echo "Starting Uvicorn..."

python -m uvicorn app:app --host 127.0.0.1 --port $PORT --reload &

# Wait for the server to start
sleep 2

echo "Opening browser..."
open "http://127.0.0.1:$PORT"

wait $!