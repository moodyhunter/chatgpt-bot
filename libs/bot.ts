import { Message, OpenAI, TelegramBot } from "../deps.ts";
import * as Logging from "./logging.ts";
import { AppState } from "./app.ts";

type ChatContext = {
    params: OpenAI.Chat.ChatCompletionMessageParam[];
    model: string;
};

function getMessageId(msg: Message): string {
    return `msgid:${msg.chat.id}-${msg.message_id}`;
}

async function getOpenAIReply(
    openai: OpenAI,
    overrideModel: string,
    params: OpenAI.Chat.ChatCompletionMessageParam[],
) {
    const resp = await openai.chat.completions.create({
        model: overrideModel,
        messages: params,
        stream: false
    });

    const reply = resp.choices?.reduce((accum, elem) => {
        return `${accum}\n${elem.message?.content}`;
    }, "");

    return reply;
}

async function updateContext(state: AppState, context_id: string, context: ChatContext) {
    console.log("update context: " + context_id + " " + JSON.stringify(context));
    await state.redis.set(context_id, JSON.stringify(context));
}

async function linkMessageWithContext(state: AppState, message_id: string, context_id: string) {
    console.log("link message with context: " + message_id + " " + context_id);
    await state.redis.set(message_id, context_id);
}

async function doOpenAI(bot: TelegramBot, state: AppState, usermsg: Message, model: string, messages: OpenAI.Chat.ChatCompletionMessageParam[], context_id: string) {
    try {
        const respmsg = await bot.sendMessage(
            usermsg.chat.id,
            `Waiting for reply from model \`${model}\`...`,
            {
                reply_to_message_id: usermsg.message_id,
                parse_mode: 'Markdown',
            },
        );

        await updateContext(state, context_id, { model: model, params: messages });
        await linkMessageWithContext(state, getMessageId(respmsg), context_id);

        const reply = await getOpenAIReply(state.openai, model, messages);
        await doWriteReply(reply, respmsg, bot, state, context_id);
    } catch (error) {
        await bot.sendMessage(
            usermsg.chat.id,
            "Internal error, pls @🍊",
        );
        if (error.response) {
            if (error.response.status) {
                Logging.error(
                    `[OpenAI] ${JSON.stringify(error.response.data)}`,
                );
                return;
            } else if (error.response.body) {
                const data = error.response.body;
                Logging.error(`[Telegram](${data.description})`);
                return;
            }
        } else {
            Logging.error(`[Unexpected Error] ${error.message}`);
        }
    }
}

async function doWriteReply(reply: string, respmsg: Message, bot: TelegramBot, state: AppState, context_id: string) {
    const PART_SIZE = 2048;

    const parts = [];
    for (let i = 0; i < reply.length; i += PART_SIZE) {
        parts.push(reply.substring(i, i + PART_SIZE));
    }

    let prevmsg = respmsg;
    const chatid = respmsg.chat.id;

    for (let i = 0; i < parts.length; i++) {
        if (i == 0) {
            try {
                await bot.editMessageText(parts[i], { chat_id: chatid, message_id: respmsg.message_id, parse_mode: 'Markdown' });
            } catch (e) {
                // fallback to plaintext
                await bot.editMessageText(parts[i], { chat_id: chatid, message_id: respmsg.message_id });
                await bot.sendMessage(chatid, "Error while parsing markdown, fallback to plaintext: " + e.message);
            }

            continue;
        }

        try {
            const msg2 = await bot.sendMessage(chatid, parts[i], { reply_to_message_id: prevmsg.message_id, parse_mode: 'Markdown' });
            prevmsg = msg2;
        } catch (e) {
            const msg2 = await bot.sendMessage(chatid, parts[i], { reply_to_message_id: prevmsg.message_id });
            prevmsg = msg2;
            await bot.sendMessage(chatid, "Error while parsing markdown, fallback to plaintext: " + e.message);
        }

        await linkMessageWithContext(state, getMessageId(prevmsg), context_id);
    }
}

async function reply_handler(bot: TelegramBot, usermsg: Message, state: AppState) {
    if (!usermsg.reply_to_message) {
        return;
    }

    const identifier = getMessageId(usermsg.reply_to_message); // id of bot's response
    const context_id = await state.redis.get(identifier);
    if (!context_id) {
        await bot.sendMessage(
            usermsg.chat.id,
            "No context found for this message? This bot is a 🤡",
            { reply_to_message_id: usermsg.message_id }
        );
        return;
    }

    const context = await state.redis.get(context_id).then((data) => {
        if (data) {
            try {
                return JSON.parse(data) as ChatContext;
            } catch {
                return null;
            }
        } else {
            return null;
        }
    });

    if (!context) {
        await bot.sendMessage(
            usermsg.chat.id,
            "No context found for this message? This bot is a 🤡",
            { reply_to_message_id: usermsg.message_id }
        );
        return;
    }

    if (usermsg.text === undefined) {
        await bot.sendMessage(
            usermsg.chat.id,
            "Non-text message is currently unsupported",
            { reply_to_message_id: usermsg.message_id }
        );
        return;
    }

    context.params.push({ role: "user", content: usermsg.text });
    doOpenAI(bot, state, usermsg, context.model, context.params, context_id);
}

export async function dispatch(bot_token: string, state: AppState) {
    const bot = new TelegramBot(bot_token, { polling: true });
    const botID = await bot.getMe().then((info) => info.id);

    bot.onText(/^\/start (.+)/, async (msg) => {
        await bot.sendMessage(msg.chat.id, "Usage: /openai <text> or /openai3 <text>");
    });

    // Dispatcher
    bot.on("message", async (usermsg) => {
        const chatID = usermsg.chat.id;
        const chatName = usermsg.chat.first_name || usermsg.chat.last_name ||
            usermsg.chat.username;
        const username = usermsg.from?.first_name || usermsg.from?.last_name ||
            usermsg.from?.username;

        if (!state.whitelist.includes(chatID)) {
            await bot.sendMessage(usermsg.chat.id, "Permission denied");
            Logging.warning(
                `${chatName}(${chatID}) attempt to use this bot, rejected`,
            );
            return;
        }

        if (!usermsg.text) {
            return;
        }

        const MSG_REGEX = /^\/openai(|3)(@babababababababababababababot)? (.+)/ms;
        const command_payload = usermsg.text.match(MSG_REGEX);
        const is_replying_to_bot = usermsg.reply_to_message && usermsg.reply_to_message.from && usermsg.reply_to_message.from.id === botID;

        if (command_payload) {
            if (command_payload.length <= 1) {
                await bot.sendMessage(usermsg.chat.id, "Usage: /openai <Text>");
                return;
            }

            Logging.info(
                `${username} in chat ${chatName}(${chatID}) starting new chat`,
            );

            const context_id = `ctx:${usermsg.chat.id}-${usermsg.message_id}`;
            Logging.subInfo("new chat context id: " + context_id);

            const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
                { role: "system", content: "you should be helpful" },
                { role: "user", content: command_payload[3] },
            ];

            const model = command_payload[1] == '3' ? 'gpt-3.5-turbo' : state.model;
            await doOpenAI(bot, state, usermsg, model, messages, context_id);
        } else if (is_replying_to_bot) {
            Logging.info(`${username} in chat ${chatName}(${chatID}) is using this bot`);


            const message = usermsg.text;
            if (message.startsWith("''") || message.startsWith("//")) {
                return;
            }

            await reply_handler(bot, usermsg, state);
        }
    });
}
