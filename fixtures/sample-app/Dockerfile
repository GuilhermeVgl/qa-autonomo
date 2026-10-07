FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
USER node
EXPOSE 4000
CMD ["node", "server.mjs"]
