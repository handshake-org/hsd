FROM node:9.11-stretch

RUN apt-get update && apt-get install git make -y

COPY . /opt/hsd
WORKDIR /opt/hsd

RUN npm install --production && \
	npm install bcrypto https://github.com/cryptocoinjs/secp256k1-node && \
	ln -s /opt/hsd/bin/hsd /usr/bin/hsd

ENTRYPOINT [ "/usr/bin/hsd" ]
