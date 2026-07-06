FROM python:3.11-slim

WORKDIR /app

COPY social-ingest/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY social-ingest/*.py ./

ENV SOCIAL_INGEST_URL=http://web:3000/api/social/ingest
ENV SESSION_DIR=/app/sessions
ENV SOCIAL_SESSION_NAME=session_search

CMD ["python", "main.py"]
