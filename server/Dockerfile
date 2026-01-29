FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY signaling_server.py .

# Expose WebSocket port
EXPOSE 8765

# Run the signaling server
CMD ["python", "signaling_server.py"]
