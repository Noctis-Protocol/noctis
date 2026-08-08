#!/bin/bash
# Kill all node processes
killall -9 node 2>/dev/null || true
sleep 2

# Start Next.js on port 3000
cd "$(dirname "$0")" && PORT=3000 npm run dev
