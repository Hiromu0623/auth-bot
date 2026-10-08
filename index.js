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
    MessageFlags,
    ActivityType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
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

// サーバー数をステータス（アクティビティ）に反映する関数
function updatePresence() {
    const guildCount = client.guilds.cache.size;
    client.user.setActivity({
        name: `導入サーバー数: ${guildCount}サーバー`,
        type: ActivityType.Watching // 「〜を観る」
    });
}

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

    // ステータス（かんがえるところ）にサーバー数を表示
    updatePresence();

    try {
        for (const guild of client.guilds.cache.values()) {
            await guild.commands.set(commands);
            console.log(`サーバー [${guild.name}] にコマンドを登録しました。`);
        }
    } catch (error) {
        console.error('コマンドの登録に失敗しました:', error);
    }
});

// 新しいサーバーに追加されたとき
client.on(Events.GuildCreate, async guild => {
    updatePresence(); // カウントを更新
    try {
        await guild.commands.set(commands);
        console.log(`新しいサーバー [${guild.name}] にコマンドを登録しました。`);

        // Botがメッセージを送信できる最初のテキストチャンネル（デフォルトチャンネル）を探す
        const defaultChannel = guild.channels.cache.find(c => 
            c.type === ChannelType.GuildText && 
            c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)
        );

        if (defaultChannel) {
            await defaultChannel.send(
                '# サーバーに認証Botを入れていただき、ありがとうございます！\n' +
                'このBotは、サイトで認証をするBotです！\n' +
                '/auth-create <チャンネル> : 指定したチャンネルに認証メッセージを作成します！\n' +
                '/auth-delete : 作成した認証メッセージを削除します。Botが再起動された場合は、リセットされてしまうため、手動での削除が必要です。'
            );
        }
    } catch (error) {
        console.error('サーバー参加時の処理に失敗しました:', error);
    }
});

// サーバーから退出（削除）されたとき
client.on(Events.GuildDelete, () => {
    updatePresence(); // カウントを更新
});

// メンバーの情報が更新されたとき（認証完了によるロール付与を検知してDMを送信）
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const roleName = '認証済み';
    
    // 変更前に「認証済み」ロールを持っておらず、変更後に持っているかチェック
    const hadRole = oldMember.roles.cache.some(role => role.name === roleName);
    const hasRole = newMember.roles.cache.some(role => role.name === roleName);

    if (!hadRole && hasRole) {
        try {
            await newMember.send(`# ${newMember.guild.name}の認証が完了しました！\nサーバーをお楽しみください！！`);
            console.log(`[認証完了] ${newMember.user.tag} にDMを送信しました。`);
        } catch (error) {
            console.error(`[DM送信エラー] ${newMember.user.tag} (DMがオフに設定されている可能性があります):`, error);
        }
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
                        color: '#1fbb41', // Discordカラー
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
                    content: '# 【サーバー認証】\n**下の「認証する」ボタンを押して、認証ページへ進んでください。**',
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

            // リンクボタン用のアクション行と、「別の方法」ボタン用のアクション行（Discordの仕様上、Linkボタンと通常ボタンは別行にする必要があります）
            const linkRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('サイトを開く')
                        .setStyle(ButtonStyle.Link)
                        .setURL(authUrl)
                );

            const altRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('alt_auth_btn')
                        .setLabel('別の方法')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.editReply({
                content: '認証用のリンクを発行しました！以下のリンクからログインを進めてください！別の方法を使用するには「別の方法」をクリックしてください。',
                components: [linkRow, altRow]
            });
        }
        
        // 「別の方法」ボタンが押されたときの処理
        else if (interaction.customId === 'alt_auth_btn') {
            // 画像認証用のモーダル（入力フォーム）を表示する
            const modal = new ModalBuilder()
                .setCustomId('alt_auth_modal')
                .setTitle('画像認証');

            const answerInput = new TextInputBuilder()
                .setCustomId('answer_input')
                .setLabel('以下の画像の暗号を見て、答えてください。')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('ここに回答を入力してください')
                .setRequired(true);

            const row = new ActionRowBuilder().addComponents(answerInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        }
    }

    // 3. モーダル（画像認証の回答）が送信されたときの処理
    else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'alt_auth_modal') {
            const answer = interaction.fields.getTextInputValue('answer_input');

            // ここで画像認証の回答を検証する処理などを追加できます
            await interaction.reply({
                content: `別の方法が選択されたため、画像認証を行います。\n回答を受け付けました: ${answer}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
});

// ボット起動
client.login(process.env.DISCORD_BOT_TOKEN);

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Web server is running on port ${PORT}`);
});
