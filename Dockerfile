FROM nginx:stable-alpine

# Copy static site
COPY ./ /usr/share/nginx/html/

# Nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ || exit 1

