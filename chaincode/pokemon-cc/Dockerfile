# PokeChain ccaas chaincode runtime (Docker 28/29 fallback, see scripts/deployCC.sh)
# Built by network/docker-compose.yaml service pokechain-cc (profile: ccaas).

FROM node:20-alpine AS build
WORKDIR /chaincode
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /chaincode
RUN addgroup -S cc && adduser -S cc -G cc
COPY --from=build /chaincode/node_modules ./node_modules
COPY --from=build /chaincode/dist ./dist
COPY package.json ./
USER cc
EXPOSE 19999
CMD ["node", "dist/server.js"]
