FROM node:alpine AS build
RUN apk add --no-cache g++ gcc bash make unbound-dev python2
RUN mkdir /hsd
WORKDIR /hsd
COPY package.json .
ARG NODE_ENV=production
RUN npm install



FROM node:alpine
WORKDIR /home/hsd

#Set up non-root user to run as
RUN adduser -S hsd
USER hsd
RUN mkdir -p /home/hsd/.hsd

#Install the required binaries and libs 
COPY bin/ /home/hsd/bin
COPY lib/ /home/hsd/lib

#Copy the installed version from build image
COPY --from=build /hsd /home/hsd

ENV PATH="${PATH}:/home/hsd/bin:/home/hsd/node_modules/.bin"

EXPOSE 13037 13038 13039 15349 15350 5300
VOLUME /home/hsd/.hsd
CMD ["hsd"]
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD [ "hsd info >/dev/null" ]
