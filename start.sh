#!/usr/bin/env bash
set -e

PORT=8080
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$PROJECT_DIR"

echo "=========================================="
echo "📌 Raum-Notizen WebXR Server & Tunnel"
echo "=========================================="

# Check if python3 is available
if command -v python3 &> /dev/null; then
    echo "Starting static HTTP server on port $PORT..."
    python3 -m http.server $PORT > /dev/null 2>&1 &
    SERVER_PID=$!
else
    echo "Error: python3 is required to run the HTTP server."
    exit 1
fi

trap "echo 'Stopping server...'; kill $SERVER_PID 2>/dev/null; exit 0" INT TERM EXIT

sleep 1

# Check cloudflared
if command -v cloudflared &> /dev/null; then
    echo "Starting cloudflared Quick Tunnel..."
    echo "------------------------------------------"
    cloudflared tunnel --url http://localhost:$PORT
else
    echo "------------------------------------------"
    echo "HTTP Server running at: http://localhost:$PORT"
    echo "Note: WebXR requires HTTPS! Please install cloudflared or use npx localtunnel."
    echo "To install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/"
    wait $SERVER_PID
fi
