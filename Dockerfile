FROM denoland/deno:debian

RUN mkdir /app
WORKDIR /app

COPY ./deno.lock ./deno.lock
#RUN deno cache --lock=deno.lock ./main.ts
COPY ./main.ts ./main.ts

CMD ["deno", "run", "--lock=deno.lock", "--allow-env", "--unstable-cron", "--allow-net=0.0.0.0:8080,api.telegram.org:443,cloud.tionis.dev:443", "main.ts"]
