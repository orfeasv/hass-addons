# Newer Supervisors don't pass BUILD_FROM; 3.22 (Node 22) is the last for armhf/armv7/i386
ARG BUILD_ARCH=amd64
ARG BUILD_FROM=ghcr.io/home-assistant/${BUILD_ARCH}-base:3.22
FROM $BUILD_FROM

RUN apk add --no-cache nodejs

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

COPY run.sh /
RUN chmod a+x /run.sh

EXPOSE 3400/tcp

CMD [ "/run.sh" ]
