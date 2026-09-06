FROM python:3.12-slim
RUN pip install --no-cache-dir httpx numpy pillow
COPY python/robo_harness/client.py /opt/robo/robo_client.py
ENV PYTHONPATH=/opt/robo
WORKDIR /workspace
CMD ["sh"]
