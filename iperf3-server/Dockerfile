ARG BUILD_FROM
FROM $BUILD_FROM

# Install iperf3 and create non-root user
RUN apk add --no-cache \
    iperf3 \
    bash \
    jq \
    && adduser -S iperf

# Copy run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose the default iperf3 server ports
EXPOSE 5201/tcp 5201/udp

# Run as non-root user
USER iperf

CMD [ "/run.sh" ]