#!/usr/bin/env -S deno run --allow-net=cloud.tionis.dev,ntfy.tionis.dev --allow-env --unstable-cron
import * as webdav from "npm:webdav";
import * as yaml from "jsr:@std/yaml";

const token = Deno.env.get("DEADMAN_SWITCH_TOKEN")
const client = webdav.createClient(
  "https://cloud.tionis.dev/public.php/webdav",
  { username: token, password: "" },
);

interface trigger {
  PingDelaySeconds: number;
  NotificationRepeatDelaySeconds?: number; // Defaults to PingDelaySeconds
}

async function notify(
  source: string | undefined,
  channel: string | undefined,
  content: object | string,
  silent: boolean | undefined = false,
) {
  const token = Deno.env.get("GUPPI_TELEGRAM_TOKEN");
  if (token === undefined || token === "") {
    throw new Error("Telegram token not set");
  }
  const chatId = "248533143";
  let message = `${source || "unknown"}@${channel || "unknown"}:\n`;
  switch (typeof content) {
    case "string":
      message += content;
      break;
    case "object":
      message += "```json\n" + JSON.stringify(content, null, 2) + "\n```";
      break;
    default:
      message += String(content);
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      parse_mode: "markdown",
      text: message,
      disable_notification: silent,
    }),
  });
  if (resp.status !== 200) {
    console.error(await resp.text());
    throw new Error("Failed to send notification");
  }
}

/*
  Parses webdav style modTimes (e.g. "Tue, 08 Oct 2024 00:18:15 GMT") into Date objects
*/
function parseModTime(modTime: string): Date {
  return new Date(modTime);
}

async function checkDeadManTriggers() {
  const directoryContents = await client.getDirectoryContents("/");
  const triggers = (directoryContents as webdav.FileStat[]).filter((d) =>
    d.type === "directory"
  ).map((x) => x.basename);
  for (const triggerName of triggers) {
    try {
      console.log(`Checking trigger: ${triggerName}`);
      // File structure:
      // /ping -> last ping time in mod time timestamp
      // /lastNotification -> last notification time in mod time timestamp
      // /config.yaml -> config of trigger (fulfills trigger interface)

      const fileContents = await client.getFileContents(
        `${triggerName}/config.yaml`,
      );
      const config = yaml.parse(fileContents.toString()) as trigger;
      const dirContents = await client.getDirectoryContents(
        triggerName,
      ) as webdav.FileStat[];
      const lastPingFile = dirContents.find((x) => x.basename === "ping");
      if (!lastPingFile || !lastPingFile.lastmod) {
        console.log(dirContents);
        console.log(lastPingFile);
        throw new Error(
          `Ping file or lastmod not found for trigger: ${triggerName}`,
        );
      }
      const lastPing = parseModTime(lastPingFile.lastmod);
      const lastNotificationFile = dirContents.find((x) =>
        x.basename === "lastNotification"
      );
      let lastNotification: Date | undefined;
      if (lastNotificationFile && lastNotificationFile.lastmod) {
        lastNotification = parseModTime(lastNotificationFile.lastmod);
      }
      const now = new Date();
      const timeSincePing = now.getTime() - lastPing.getTime();
      const timeSinceNotification = lastNotification
        ? now.getTime() - lastNotification.getTime()
        : Number.MAX_SAFE_INTEGER;
      if (timeSincePing > config.PingDelaySeconds * 1000) {
        if (
          !lastNotification ||
          timeSinceNotification >
            (config.NotificationRepeatDelaySeconds || config.PingDelaySeconds) *
              1000
        ) {
          await notify(
            "deadManSwitchOperator",
            triggerName,
            `Last Ping was at ${lastPing.toUTCString()} but should have been within ${config.PingDelaySeconds} seconds`,
          );
          await client.putFileContents(
            `${triggerName}/lastNotification`,
            now.toUTCString(),
          );
        }
      }
    } catch (e) {
      console.error(e);
      // Append error to log over webdav
      const lock = await client.lock(`${triggerName}/error.log`);
      const logFile = `${triggerName}/error.log`;
      const logContents = await client.getFileContents(logFile);
      await client.putFileContents(
        logFile,
        `${logContents.toString()}\n${e.toString()}`,
      );
      await client.unlock(`${triggerName}/error.log`, lock.token);
    }
  }
}

Deno.cron("Check for dead man triggers", "*/5 * * * *", checkDeadManTriggers);

checkDeadManTriggers();