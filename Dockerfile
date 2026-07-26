# Pinned to match the "playwright" npm version in package.json — Playwright
# ties each npm release to an exact bundled Chromium build, so the image tag
# and the npm dependency version must stay in lockstep or launches fail.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY discord_login.js ./

CMD ["node", "discord_login.js"]
