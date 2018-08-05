FROM node:10-alpine AS build

# Install build dependencies
RUN apk add --no-cache \
		bash \
		g++ \
		gcc \
		make \
		python2 \
		unbound-dev

# Build Handshake daemon
COPY . /tmp/hsd/
RUN cd /tmp/hsd/ \
	&& npm install --production

FROM node:10-alpine

# Copy Handshake daemon
COPY --from=build /tmp/hsd/ /usr/lib/hsd/

# Install runtime dependencies
RUN apk add --no-cache \
		bash \
		unbound-libs

# Create hsd user and group
RUN addgroup -S -g 500 hsd \
	&& adduser -S -u 500 -G hsd -h /var/cache/hsd/ hsd

# Create data directory
RUN mkdir /var/cache/hsd/.hsd/ \
	&& chown hsd:hsd /var/cache/hsd/.hsd/ \
	&& ln -s /var/cache/hsd/.hsd/ /var/lib/hsd

WORKDIR /var/lib/hsd/
#VOLUME /var/lib/hsd/

USER hsd:hsd
ENTRYPOINT ["/usr/lib/hsd/bin/hsd"]
