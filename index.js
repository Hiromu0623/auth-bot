require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    PermissionFlagsBits,
    ChannelType,
    Events,
    MessageFlags
} = require('discord.js');
const crypto = require('crypto'); // トークン生成用

// ボットのクライアントを作成
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers // メンバー情報を取得・操作するために必要
    ]
});

// サーバーごとの認証メッセージIDやロールIDを保存するストレージ
const authMessages = new Map();
const guildRoles = new Map(); // guildId => roleId

// スラッシュコマンドの定義
const commands = [
    new SlashCommandBuilder()
        .setName('auth-create')
        .setDescription('認証メッセージを送信し、自動でロールを準備します')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('認証メッセージを置くチャンネル')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName('auth-delete')
        .setDescription('このサーバーの認証メッセージを削除します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        for (const guild of client.guilds.cache.values()) {
            await guild.commands.set(commands);
            console.log(`サーバー [${guild.name}] にコマンドを登録しました。`);
        }
    } catch (error) {
        console.error('コマンドの登録に失敗しました:', error);
    }
});

client.on(Events.GuildCreate, async guild => {
    try {
        await guild.commands.set(commands);
        console.log(`新しいサーバー [${guild.name}] にコマンドを登録しました。`);
    } catch (error) {
        console.error('サーバー参加時のコマンド登録に失敗しました:', error);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    // 1. スラッシュコマンドの処理
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'auth-create') {
            const channel = interaction.options.getChannel('channel');
            const guild = interaction.guild;

            try {
                // ① サーバー内に「認証済み」ロールがすでにあるか確認、なければ作成
                let authRole = guild.roles.cache.find(r => r.name === '認証済み');
                if (!authRole) {
                    authRole = await guild.roles.create({
                        name: '認証済み',
                        color: '#5865F2', // Discordカラー
                        reason: '認証システム用の自動作成ロール',
                    });
                }
                // サーバーごとのロールIDを保存
                guildRoles.set(guild.id, authRole.id);

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('start_auth')
                            .setLabel('認証する')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🔐')
                    );

                const message = await channel.send({
                    content: '### 【サーバー認証】\n下の「認証する」ボタンを押して、認証ページへ進んでください。',
                    components: [row]
                });

                authMessages.set(guild.id, message.id);

                await interaction.reply({
                    content: `${channel} に認証メッセージを設置し、「認証済み」ロールの準備が完了しました！`,
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                console.error(error);
                await interaction.reply({
                    content: '認証メッセージの送信、またはロールの作成に失敗しました。Botに「ロールの管理」権限があるか確認してください。',
                    flags: MessageFlags.Ephemeral
                });
            }
        } 
        
        else if (commandName === 'auth-delete') {
            const messageId = authMessages.get(interaction.guildId);

            if (!messageId) {
                return interaction.reply({
                    content: 'このサーバーには現在、Botが管理している認証メッセージが見つかりません。',
                    flags: MessageFlags.Ephemeral
                });
            }

            try {
                let deleted = false;
                for (const channel of interaction.guild.channels.cache.values()) {
                    if (!channel.isTextBased()) continue;
                    try {
                        const msg = await channel.messages.fetch(messageId);
                        if (msg) {
                            await msg.delete();
                            deleted = true;
                            break;
                        }
                    } catch (e) {
                        // 見つからない場合はスキップ
                    }
                }

                authMessages.delete(interaction.guildId);

                await interaction.reply({
                    content: deleted ? '認証メッセージを削除しました。' : 'メッセージはすでに削除されているか、見つかりませんでした。',
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                console.error(error);
                await interaction.reply({
                    content: '認証メッセージの削除に失敗しました。',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    }

    // 2. ボタンが押されたときの処理
    else if (interaction.isButton()) {
        if (interaction.customId === 'start_auth') {
            // Discordの3秒制限（Unknown interaction）を回避するための返事
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const token = crypto.randomBytes(32).toString('hex');
            const guildId = interaction.guildId;
            const userId = interaction.user.id;

            try {
                const response = await fetch('https://hiromu0623-discord-auth.pages.dev/api/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'register',
                        token: token,
                        guildId: guildId,
                        userId: userId
                    })
                });

                // レスポンスがJSONかテキストかを安全にチェック
                const text = await response.text();
                let result;
                try {
                    result = JSON.parse(text);
                } catch (e) {
                    throw new Error(`Cloudflareから不正な応答が返りました: ${text.slice(0, 100)}`);
                }

                if (!result.success) {
                    console.error('Cloudflare側でのトークン登録に失敗:', result.error);
                    return interaction.editReply({ content: '認証の初期化に失敗しました。' });
                }
            } catch (err) {
                console.error('Cloudflareへの通信エラー:', err);
                return interaction.editReply({ content: `認証サーバーへの接続に失敗しました: ${err.message}` });
            }

            const authUrl = `https://hiromu0623-discord-auth.pages.dev/?token=${token}`;

            await interaction.editReply({
                content: `認証用のリンクを発行しました！\n以下のリンクからログインを進めてください（※このリンクはあなた専用です）\n\n${authUrl}`
            });
        }
    }
});

// ボット起動
client.login(process.env.DISCORD_TOKEN);