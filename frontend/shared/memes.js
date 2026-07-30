'use strict';

// Generated from resources/memes/catalog.json. Instruction bodies deliberately stay
// outside the renderer bundle; this file exposes only validated presentation data.
(function attachPublicMemeCatalog(global) {
  const data = {
  "schemaVersion": 1,
  "sourceSha256": "c49f3188a36ce2184876c2adb1973022c33c1f79355b54a566934b802625b46a",
  "items": [
    {
      "id": "huaqiang-guaranteed",
      "category": "delivery-review",
      "media": {
        "gif": "huaqiang-guaranteed/visual.gif",
        "audio": "huaqiang-guaranteed/voice.mp3",
        "durationMs": 2600,
        "placement": "pet-right"
      },
      "reaction": {
        "state": "sorry",
        "durationMs": 2600
      },
      "copy": {
        "zh": {
          "label": "你这瓜保熟吗？",
          "description": "用户耐心快耗尽了：别卖生瓜蛋子，当场劈开验货",
          "reactionLabel": "汗流浃背，马上复验"
        },
        "en": {
          "label": "Source: trust me bro?",
          "description": "Patience gone — no unverified claims, prove it actually runs",
          "reactionLabel": "Cold sweat — re-verifying now"
        },
        "ja": {
          "label": "それってあなたの感想ですよね？",
          "description": "もう我慢の限界 — 感想じゃなくて根拠を出して",
          "reactionLabel": "冷や汗、今すぐ検証し直します"
        }
      }
    },
    {
      "id": "ni-gan-ma",
      "category": "scope-control",
      "media": {
        "gif": "ni-gan-ma/visual.gif",
        "audio": "ni-gan-ma/voice.mp3",
        "durationMs": 4400,
        "placement": "pet-right"
      },
      "reaction": {
        "state": "puzzled",
        "durationMs": 4400
      },
      "copy": {
        "zh": {
          "label": "你干嘛呀～",
          "description": "范围又跑偏了：回来，只做当前这一件事",
          "reactionLabel": "被当场问住，马上收回范围"
        },
        "en": {
          "label": "What are you doing?",
          "description": "The scope wandered again — come back and finish the one thing in front of you",
          "reactionLabel": "Caught drifting — narrowing back to the task"
        },
        "ja": {
          "label": "何してるの？",
          "description": "また話がそれてる — 戻って、今の一件だけを最後までやって",
          "reactionLabel": "脱線がばれた、今の作業だけに戻ります"
        }
      }
    }
  ]
};
  global.LLMPET_MEMES = Object.freeze(data);
})(window);
