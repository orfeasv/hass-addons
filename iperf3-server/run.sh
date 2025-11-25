#!/usr/bin/with-contenv bashio

# Get configuration from options
PORT=$(bashio::config 'port')
VERBOSE=$(bashio::config 'verbose')

bashio::log.info "Starting iPerf3 server on port ${PORT}..."

# Build iperf3 command
CMD="iperf3 -s -p ${PORT}"

if bashio::config.true 'verbose'; then
    CMD="${CMD} -V"
    bashio::log.info "Verbose mode enabled"
fi

# Start iPerf3 server
bashio::log.info "Running: ${CMD}"
exec ${CMD}