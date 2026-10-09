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
    TextInputStyle,
    AttachmentBuilder
} = require('discord.js');
const crypto = require('crypto');
const { Captcha } = require('captcha-canvas'); // 画像認証用

// ボットのクライアントを作成（MessageContentインテントを追加）
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages, // メッセージ検知用
        GatewayIntentBits.MessageContent // メッセージの内容を読むために必須
    ]
});

// 各種データストレージ（メモリ保存）
const authMessages = new Map();
const guildRoles = new Map(); // guildId => authRoleId
const captchaStore = new Map(); // userId => captchaText (画像認証の答え)
const ticketPanels = new Map(); // messageId => [roleId, roleId...] (チケットアクセス権)

// セキュリティ用データストレージ
const securitySettings = new Map(); // guildId => { enabled: boolean, logChannelId: string, exemptChannels: Set<string> }
const spamTracker = new Map(); // guildId => Map(userId => { mentions: [timestamp], messages: [{id, content, time}] })

function updatePresence() {
    const guildCount = client.guilds.cache.size;
    client.user.setActivity({
        name: `導入サーバー数: ${guildCount}サーバー`,
        type: ActivityType.Watching
    });
}

// 違反時のDM＆ログ送信関数
async function handleViolation(member, guild, reason, punishment) {
    // DM送信
    try {
        await member.send(
            `# 違反が検知されました\nあなたは${guild.name}で${reason}をしたため、**${punishment}**されました。`
        );
    } catch (e) {
        console.error('DM送信エラー (スパム処罰):', e);
    }
    // ログ送信
    const settings = securitySettings.get(guild.id);
    if (settings && settings.logChannelId) {
        const logChannel = guild.channels.cache.get(settings.logChannelId);
        if (logChannel) {
            await logChannel.send(`🚨 **セキュリティ発動**\nユーザー: ${member.user.tag} (${member.id})\n理由: ${reason}\n処罰: ${punishment}`).catch(()=>{});
        }
    }
}

// コマンド定義（すべて管理者権限必須に設定）
const commands = [
    // 認証系
    new SlashCommandBuilder()
        .setName('auth-create')
        .setDescription('認証メッセージを送信し、自動でロールを準備します')
        .addChannelOption(option => option.setName('channel').setDescription('認証メッセージを置くチャンネル').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('auth-delete')
        .setDescription('このサーバーの認証メッセージを削除します')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
    // チケット系
    new SlashCommandBuilder()
        .setName('ticket-create')
        .setDescription('チケットを生成します。')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('ticket-delete')
        .setDescription('チケットを削除します。')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // セキュリティ系
    new SlashCommandBuilder()
        .setName('security-on')
        .setDescription('スパム、荒らしなどの対策モードをオンにします。')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('security-off')
        .setDescription('スパム、荒らしなどの対策モードをオフにします。(危険！)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('security-channel-off')
        .setDescription('指定したチャンネルの対策モードをオフにします。')
        .addChannelOption(option => option.setName('channel').setDescription('除外するチャンネル').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('security-channel-on')
        .setDescription('指定したチャンネルの対策モードをオンにします。')
        .addChannelOption(option => option.setName('channel').setDescription('除外を解除するチャンネル').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('security-log')
        .setDescription('人が違反した場合に表示するチャンネルを設定します。')
        .addChannelOption(option => option.setName('channel').setDescription('ログを送信するチャンネル').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    updatePresence();
    try {
        for (const guild of client.guilds.cache.values()) {
            await guild.commands.set(commands);
        }
        console.log('すべてのサーバーにコマンドを登録しました。');
    } catch (error) {
        console.error('コマンド登録エラー:', error);
    }
});

client.on(Events.GuildCreate, async guild => {
    updatePresence();
    try {
        await guild.commands.set(commands);
        const defaultChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages));
        if (defaultChannel) {
            await defaultChannel.send(
                '# サーバーに認証Botを入れていただき、ありがとうございます！\n' +
                'このBotは、サイトで認証をするBotです！\n' +
                '/auth-create <チャンネル> : 指定したチャンネルに認証メッセージを作成します！\n' +
                '/auth-delete : 作成した認証メッセージを削除します。Botが再起動された場合は、リセットされてしまうため、手動での削除が必要です。'
            );
        }
    } catch (error) {}
});

client.on(Events.GuildDelete, () => updatePresence());

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const roleName = '認証済み';
    const hadRole = oldMember.roles.cache.some(role => role.name === roleName);
    const hasRole = newMember.roles.cache.some(role => role.name === roleName);

    if (!hadRole && hasRole) {
        try {
            await newMember.send(`# ${newMember.guild.name}の認証が完了しました！\nサーバーをお楽しみください！！`);
        } catch (error) {}
    }
});

// ----------------------------------------------------
// スパム検知・セキュリティシステム
// ----------------------------------------------------
client.on(Events.MessageCreate, async message => {
    if (!message.guild || message.author.id === client.user.id) return;

    const guildId = message.guild.id;
    const settings = securitySettings.get(guildId);
    
    // セキュリティがオフ、または対象外チャンネル、または管理者の場合はスキップ
    if (!settings || !settings.enabled) return;
    if (settings.exemptChannels.has(message.channel.id)) return;
    if (message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

    const userId = message.author.id;
    const isBot = message.author.bot;
    const now = Date.now();
    const member = message.member;

    if (!spamTracker.has(guildId)) spamTracker.set(guildId, new Map());
    const guildTracker = spamTracker.get(guildId);
    if (!guildTracker.has(userId)) guildTracker.set(userId, { mentions: [], messages: [] });
    const userTracker = guildTracker.get(userId);

    // 1. 他サーバーの招待リンク検知
    if (/(discord\.gg\/|discord\.com\/invite\/)/i.test(message.content)) {
        await message.delete().catch(() => {});
        if (member && member.manageable) {
            await member.timeout(10 * 60 * 1000, '別のDiscordサーバーのリンクを送信したため').catch(() => {});
            await handleViolation(member, message.guild, '別のdiscordサーバーのリンクを送信', '10分タイムアウト');
        }
        return;
    }

    // 2. @everyone メンションスパム検知
    if (message.mentions.everyone) {
        userTracker.mentions.push(now);
        const last10s = userTracker.mentions.filter(t => now - t <= 10000);
        const last60s = userTracker.mentions.filter(t => now - t <= 60000);
        userTracker.mentions = last60s; // メモリ節約

        let shouldBan = false;
        let reason = '';
        if (isBot && last10s.length >= 5) {
            shouldBan = true;
            reason = 'Botが@everyoneを10秒間に5回メンションした';
        } else if (!isBot && (last10s.length >= 5 || last60s.length >= 10)) {
            shouldBan = true;
            reason = '人が@everyoneを10秒間に5回メンションまたは1分間に10回メンションした';
        }

        if (shouldBan && member && member.manageable) {
            await handleViolation(member, message.guild, reason, 'BAN');
            await message.guild.members.ban(userId, { deleteMessageSeconds: 60 * 60, reason }).catch(() => {});
            return;
        }
    }

    // 3. 連投スパム検知 (直近5分間を記録)
    userTracker.messages.push({ id: message.id, content: message.content, time: now });
    userTracker.messages = userTracker.messages.filter(m => now - m.time <= 300000); 

    const recentMessages = userTracker.messages;
    
    // 同じ言葉を10回連投
    const sameContentMsgs = recentMessages.filter(m => m.content === message.content);
    if (sameContentMsgs.length >= 10) {
        const msgIds = sameContentMsgs.map(m => m.id);
        await message.channel.bulkDelete(msgIds).catch(() => {});
        userTracker.messages = recentMessages.filter(m => m.content !== message.content); // カウントリセット
        if (member && member.manageable) {
            await member.timeout(60 * 60 * 1000, '同じ言葉を10回連投したため').catch(() => {});
            await handleViolation(member, message.guild, '同じ言葉を10回連投した', '1時間タイムアウト');
        }
        return;
    }

    // 短い言葉(5文字以下)を20回以上連投
    if (message.content.length <= 5) {
        const shortMsgs = recentMessages.filter(m => m.content.length <= 5);
        if (shortMsgs.length >= 20) {
            const msgIds = shortMsgs.map(m => m.id);
            await message.channel.bulkDelete(msgIds).catch(() => {});
            userTracker.messages = recentMessages.filter(m => m.content.length > 5);
            if (member && member.manageable) {
                await member.timeout(60 * 60 * 1000, '短い言葉を20回以上連投したため').catch(() => {});
                await handleViolation(member, message.guild, '短い言葉を20回以上連投した', '1時間タイムアウト');
            }
        }
    }
});

// ----------------------------------------------------
// スラッシュコマンド & インタラクション処理
// ----------------------------------------------------
client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        const guildId = interaction.guildId;

        // --- セキュリティコマンド ---
        if (commandName.startsWith('security-')) {
            if (!securitySettings.has(guildId)) {
                securitySettings.set(guildId, { enabled: false, logChannelId: null, exemptChannels: new Set() });
            }
            const settings = securitySettings.get(guildId);

            if (commandName === 'security-on') {
                settings.enabled = true;
                return interaction.reply({ content: '✅ スパム・荒らし対策モードを **オン** にしました。', flags: MessageFlags.Ephemeral });
            } 
            else if (commandName === 'security-off') {
                settings.enabled = false;
                return interaction.reply({ content: '⚠️ スパム・荒らし対策モードを **オフ** にしました。', flags: MessageFlags.Ephemeral });
            }
            else if (commandName === 'security-channel-off') {
                const channel = interaction.options.getChannel('channel');
                settings.exemptChannels.add(channel.id);
                return interaction.reply({ content: `✅ ${channel} を対策の監視対象から **除外** しました。`, flags: MessageFlags.Ephemeral });
            }
            else if (commandName === 'security-channel-on') {
                const channel = interaction.options.getChannel('channel');
                settings.exemptChannels.delete(channel.id);
                return interaction.reply({ content: `✅ ${channel} の除外を解除し、監視対象に **戻し** ました。`, flags: MessageFlags.Ephemeral });
            }
            else if (commandName === 'security-log') {
                const channel = interaction.options.getChannel('channel');
                settings.logChannelId = channel.id;
                return interaction.reply({ content: `✅ 違反ログの送信先を ${channel} に設定しました。`, flags: MessageFlags.Ephemeral });
            }
        }

        // --- 認証系コマンド ---
        else if (commandName === 'auth-create') {
            const channel = interaction.options.getChannel('channel');
            const guild = interaction.guild;
            try {
                let authRole = guild.roles.cache.find(r => r.name === '認証済み');
                if (!authRole) authRole = await guild.roles.create({ name: '認証済み', color: '#1fbb41', reason: '認証用' });
                guildRoles.set(guild.id, authRole.id);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('start_auth').setLabel('認証する').setStyle(ButtonStyle.Success).setEmoji('🔐')
                );
                const message = await channel.send({ content: '# 【サーバー認証】\n下の「認証する」ボタンを押して、認証ページへ進んでください。', components: [row] });
                authMessages.set(guild.id, message.id);
                await interaction.reply({ content: '認証メッセージを設置しました！', flags: MessageFlags.Ephemeral });
            } catch (error) {
                await interaction.reply({ content: 'エラーが発生しました。Botの権限を確認してください。', flags: MessageFlags.Ephemeral });
            }
        } 
        else if (commandName === 'auth-delete') {
            const messageId = authMessages.get(guildId);
            if (!messageId) return interaction.reply({ content: '認証メッセージが見つかりません。', flags: MessageFlags.Ephemeral });
            // メッセージ削除処理（省略せず確実に）
            let deleted = false;
            for (const channel of interaction.guild.channels.cache.values()) {
                if (!channel.isTextBased()) continue;
                try {
                    const msg = await channel.messages.fetch(messageId);
                    if (msg) { await msg.delete(); deleted = true; break; }
                } catch (e) {}
            }
            authMessages.delete(guildId);
            await interaction.reply({ content: deleted ? '認証メッセージを削除しました。' : '見つかりませんでした。', flags: MessageFlags.Ephemeral });
        }

        // --- チケット系コマンド ---
        else if (commandName === 'ticket-create') {
            const modal = new ModalBuilder().setCustomId('ticket_create_modal').setTitle('チケットパネル作成');
            
            const titleInput = new TextInputBuilder().setCustomId('ticket_title').setLabel('タイトル').setStyle(TextInputStyle.Short).setPlaceholder('例 : チケットの作成はこちら').setRequired(true);
            const descInput = new TextInputBuilder().setCustomId('ticket_desc').setLabel('説明').setStyle(TextInputStyle.Paragraph).setPlaceholder('例 : チケットを作成するにはここをクリックしてください').setRequired(true);
            const rolesInput = new TextInputBuilder().setCustomId('ticket_roles').setLabel('<上級者向け>追加ロールID(カンマ区切り)').setStyle(TextInputStyle.Short).setPlaceholder('例 : 1234567890 (未入力OK)').setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(descInput),
                new ActionRowBuilder().addComponents(rolesInput)
            );

            await interaction.showModal(modal);
        }
        else if (commandName === 'ticket-delete') {
            await interaction.reply({ content: 'このチケット（チャンネル）を削除します...', flags: MessageFlags.Ephemeral });
            setTimeout(() => interaction.channel.delete().catch(()=>{}), 2000);
        }
    }

    // --- ボタン処理 ---
    else if (interaction.isButton()) {
        // 1. 認証開始ボタン
        if (interaction.customId === 'start_auth') {
            // すでに認証済みかチェック
            const authRoleId = guildRoles.get(interaction.guildId) || interaction.guild.roles.cache.find(r => r.name === '認証済み')?.id;
            if (authRoleId && interaction.member.roles.cache.has(authRoleId)) {
                return interaction.reply({ content: '# 認証完了\nあなたは既に認証が完了しています！', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const token = crypto.randomBytes(32).toString('hex');
            
            // Cloudflare APIは省略せずそのまま
            try {
                const response = await fetch('https://hiromu0623-discord-auth.pages.dev/api/verify', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register', token: token, guildId: interaction.guildId, userId: interaction.user.id })
                });
                const result = JSON.parse(await response.text());
                if (!result.success) return interaction.editReply({ content: '認証の初期化に失敗しました。' });
            } catch (err) {
                return interaction.editReply({ content: '通信エラーが発生しました。' });
            }

            const authUrl = `https://hiromu0623-discord-auth.pages.dev/auth/?token=${token}`;
            const linkRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('サイトを開く').setStyle(ButtonStyle.Link).setURL(authUrl),
                new ButtonBuilder().setCustomId('alt_auth_btn').setLabel('別の方法').setStyle(ButtonStyle.Primary) // 青色ボタン
            );

            await interaction.editReply({
                content: '認証用のリンクを発行しました！以下のリンクからログインを進めてください',
                components: [linkRow]
            });
        }
        
        // 2. 別の方法（画像認証生成）ボタン
        else if (interaction.customId === 'alt_auth_btn') {
            await interaction.deferUpdate(); // ボタンの読み込みを完了させる

            // キャプチャの生成
            const captcha = new Captcha();
            captcha.async = false;
            captcha.addDecoy(); // ノイズ追加
            captcha.drawTrace(); // 線を追加
            captcha.drawCaptcha(); // テキストを描画

            // 正解の文字列をメモリに保存
            captchaStore.set(interaction.user.id, captcha.text);

            const attachment = new AttachmentBuilder(captcha.png, { name: 'captcha.png' });
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('open_captcha_modal_btn').setLabel('回答').setStyle(ButtonStyle.Success)
            );

            await interaction.followUp({
                content: '別の方法が選択されたため、画像認証を行います。\n以下の画像に書いてある暗号を入力してください',
                files: [attachment],
                components: [row],
                flags: MessageFlags.Ephemeral
            });
        }

        // 3. 回答（モーダルを開く）ボタン
        else if (interaction.customId === 'open_captcha_modal_btn') {
            const modal = new ModalBuilder().setCustomId('captcha_answer_modal').setTitle('画像認証');
            const answerInput = new TextInputBuilder()
                .setCustomId('captcha_answer_input')
                .setLabel('画像に書いてある暗号を入力してください')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(answerInput));
            await interaction.showModal(modal);
        }

        // 4. チケット作成ボタン
        else if (interaction.customId === 'create_ticket_btn') {
            const allowedRoles = ticketPanels.get(interaction.message.id) || [];
            const guild = interaction.guild;

            // チャンネルの権限設定
            const permissionOverwrites = [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // everyone拒否
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, // 本人許可
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] } // Bot許可
            ];
            // 追加ロールの許可
            for (const roleId of allowedRoles) {
                if (guild.roles.cache.has(roleId)) {
                    permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
                }
            }

            try {
                const ticketChannel = await guild.channels.create({
                    name: `ticket-${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: permissionOverwrites
                });
                await interaction.reply({ content: `${ticketChannel} が作成されました！`, flags: MessageFlags.Ephemeral });
                await ticketChannel.send(`<@${interaction.user.id}> チケットを作成しました。用件をご入力ください。`);
            } catch (error) {
                console.error(error);
                await interaction.reply({ content: 'チケットの作成に失敗しました。', flags: MessageFlags.Ephemeral });
            }
        }
    }

    // --- モーダル送信処理 ---
    else if (interaction.isModalSubmit()) {
        // 1. 画像認証の回答
        if (interaction.customId === 'captcha_answer_modal') {
            const answer = interaction.fields.getTextInputValue('captcha_answer_input');
            const correctAnswer = captchaStore.get(interaction.user.id);

            if (answer === correctAnswer) {
                // 正解
                const authRoleId = guildRoles.get(interaction.guildId) || interaction.guild.roles.cache.find(r => r.name === '認証済み')?.id;
                if (authRoleId) {
                    await interaction.member.roles.add(authRoleId).catch(console.error);
                }
                captchaStore.delete(interaction.user.id); // 使い終わったら消す
                await interaction.reply({ content: '# 認証完了\n画像認証に成功しました！ロールを付与しました。', flags: MessageFlags.Ephemeral });
            } else {
                // 不正解
                await interaction.reply({ content: '暗号が間違っています。「別の方法」または「回答」ボタンからやり直してください。', flags: MessageFlags.Ephemeral });
            }
        }

        // 2. チケットパネルの作成
        else if (interaction.customId === 'ticket_create_modal') {
            const title = interaction.fields.getTextInputValue('ticket_title');
            const desc = interaction.fields.getTextInputValue('ticket_desc');
            const rolesStr = interaction.fields.getTextInputValue('ticket_roles');
            
            // ロールIDをカンマで分割して配列にする（空白除去）
            const roleIds = rolesStr ? rolesStr.split(',').map(id => id.trim()).filter(id => id.length > 0) : [];

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('create_ticket_btn').setLabel('チケットを作成').setStyle(ButtonStyle.Success).setEmoji('🎫')
            );

            const panelMessage = await interaction.channel.send({
                content: `# ${title}\n## ${desc}`,
                components: [row]
            });

            // このパネルから作られるチケットにアクセスできるロールを保存
            ticketPanels.set(panelMessage.id, roleIds);

            await interaction.reply({ content: 'チケットパネルを生成しました。', flags: MessageFlags.Ephemeral });
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);

// Render等のタイムアウト回避用Webサーバー
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Web server is running on port ${PORT}`));
