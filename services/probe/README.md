# Upload probe

Small server that accepts `PUT /v1/probe/{nonce}` (1.5 MB), discards the body and logs timing. Runs on Azure Container Apps, South Africa North. Never cached and never proxied through a CDN, so it measures the real radio path. Not written yet.
