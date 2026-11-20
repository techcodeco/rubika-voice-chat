"use strict";

const { VoiceClient } = require("rubika-voice-chat");

async function main() {
  const client = new VoiceClient(
    process.env.RUBIKA_AUTH,
    process.env.RUBIKA_PRIVATE_KEY_B64,
    { selfObjectGuid: process.env.RUBIKA_SELF_OBJECT_GUID },
  );
  client.on("error", (error) => console.error("[voice]", error));

  try {
    await client.start();
    await client.joinVoiceChat(process.env.RUBIKA_GROUP_GUID);
    await client.play("./music.mp3");
    await new Promise((resolve) => process.once("SIGINT", resolve));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
