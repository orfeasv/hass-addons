#!/usr/bin/with-contenv bashio

# /data persists the adb key; PORT must match ingress_port
export KEY_FILE="/data/adbkey.pem"
export PORT=3400
export BOX_HOST="$(bashio::config 'host')"
export BOX_PORT="$(bashio::config 'port')"

bashio::log.info "Starting TV Box Remote on port ${PORT}..."
exec node /app/src/server.js
