#!/usr/bin/with-contenv bashio

# /data persists the adb key; PORT must match ingress_port
export KEY_FILE="/data/adbkey.pem"
export PORT=3400
export BOX_PORT="$(bashio::config 'port')"

# ssl: https on 3401 with Home Assistant's certificate (file name only, always in /ssl), so Chrome can install the app
if bashio::config.true 'ssl'; then
    CERTFILE="$(bashio::config 'certfile')"
    KEYFILE="$(bashio::config 'keyfile')"
    CERTFILE="/ssl/${CERTFILE##*/}"
    KEYFILE="/ssl/${KEYFILE##*/}"
    if [ -f "${CERTFILE}" ] && [ -f "${KEYFILE}" ]; then
        export HTTPS_PORT=3401
        export TLS_CERT="${CERTFILE}"
        export TLS_KEY="${KEYFILE}"
        bashio::log.info "https on port ${HTTPS_PORT} with ${CERTFILE}"
    else
        bashio::log.warning "ssl is on, but ${CERTFILE} or ${KEYFILE} doesn't exist: no https"
    fi
fi

bashio::log.info "Starting TV Box Remote on port ${PORT}..."
exec node /app/src/server.js
