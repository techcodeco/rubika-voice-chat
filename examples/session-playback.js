"use strict";

const { VoiceClient } = require("rubika-voice-chat");

async function main() {
  const client = new VoiceClient("my-voice-session");
  client.on("error", (error) => console.error("[voice]", error));
  client.on("joined", () => console.log("Joined Voice Chat"));
  client.on("track-ended", (event) => console.log("Track ended:", event));
  client.on("connection-lost", (state) =>
    console.warn("Connection changed:", state),
  );

  try {
    await client.start();
    await client.joinVoiceChat(process.env.RUBIKA_GROUP_GUID);
    await client.play("./music.mp3");
    client.enqueue("./next-song.ogg");

    await new Promise((resolve) => process.once("SIGINT", resolve));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
