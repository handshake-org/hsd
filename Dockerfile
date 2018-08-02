FROM base/archlinux:latest AS base

RUN mkdir -p /code
WORKDIR /code
CMD "hsd"

RUN pacman -Sy --noconfirm archlinux-keyring && \
    pacman -Syu --noconfirm nodejs unbound && \
    rm /var/cache/pacman/pkg/*

COPY package.json \
     #package-lock.json \
     /code/

FROM base AS build
# Install build dependencies
RUN pacman -Syu --noconfirm base-devel unrar git python2 npm
#HACK: Node-gyp needs python
RUN ln -s /usr/bin/python2 /usr/bin/python

# Install hsd
RUN npm install --production

FROM base
ENV PATH="${PATH}:/code/bin:/code/node_modules/.bin"
COPY --from=build /code/node_modules /code/node_modules/
COPY bin /code/bin/
COPY lib /code/lib/

