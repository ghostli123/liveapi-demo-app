# Use an official Python runtime as a parent image
# 
FROM python:3.11

# Set the working directory in the container
WORKDIR /app

# Copy the dependency file and install dependencies
# Assuming you have a requirements.txt, add any libraries needed by main.py
# If you don't have one, you can skip this part
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your application code
# This includes main.py and your static frontend files (index.html, css, js, etc.)
COPY . .

# Cloud Run injects the port it expects traffic on via the PORT environment variable.
# The default is 8080. We need to tell the frontend server to listen on this port.
# Python's http.server binds to port 8000 by default. To make it use the 
# Cloud Run-provided port, we need a small wrapper script.
ENV PORT 8080
ENV PROJECT_ID "visionai-testing-stable"
ENV LOCATION "us-central1"

# Expose the port (mostly for documentation/local testing)
EXPOSE 8080

# Set the startup command to run the multi-process script
# We will create start.sh to manage both processes
CMD ["/bin/bash", "./start.sh"]