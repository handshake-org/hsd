FROM node:10-alpine AS base

RUN mkdir /opt/hsd
WORKDIR /opt/hsd

# dynamically linked deps
RUN apk upgrade --no-cache \
  && apk add --no-cache unbound-dev

FROM base AS build

# build deps
RUN apk upgrade --no-cache \
  && apk add --no-cache bash \
  git python2 g++ gcc make

COPY . .

RUN npm install

FROM base

ENTRYPOINT ["hsd"]

ENV PATH="${PATH}:/opt/hsd/bin:/opt/hsd/node_modules/.bin"
COPY --from=build /opt/hsd/ /opt/hsd/

# networks:
# main testnet regtest simnet

# p2p network ports
EXPOSE 12038 13038 14038 15038

# http network ports
EXPOSE 12037 13037 14037 15037

# wallet network ports
EXPOSE 12039 13039 14039 15039

# recursive dns server ports
EXPOSE 5350 15350 25350 35350
EXPOSE 5350/udp 15350/udp 25350/udp 35350/udp
