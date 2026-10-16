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
const { createCanvas, registerFont, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

// ----------------------------------------------------
// 日本語フォントの読み込み設定
// ----------------------------------------------------
const fontPath = path.join(__dirname, 'font.otf');
let FONT_FAMILY = 'sans-serif';

if (fs.existsSync(fontPath)) {
    try {
        registerFont(fontPath, { family: 'CustomJapaneseFont' });
        FONT_FAMILY = 'CustomJapaneseFont, sans-serif';
        console.log('日本語フォント (font.ttf) の読み込みに成功しました！');
    } catch (e) {
        console.error('フォント読み込みエラー:', e);
    }
} else {
    console.warn('⚠️ font.ttf が見つかりません。日本語が文字化けする可能性があります。');
}

// ボットのクライアントを作成
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages, // メッセージ検知用
        GatewayIntentBits.MessageContent // メッセージの内容を読むために必須
    ]
});

// 各種データストレージ（メモリ + 永続化）
const authMessages = new Map();
const guildRoles = new Map(); // guildId => authRoleId
const captchaStore = new Map(); // userId => captchaText (画像認証の答え)
const ticketPanels = new Map(); // messageId => [roleId, roleId...] (チケットアクセス権)
const pendingAuthInteractions = new Map(); // userId => interaction (認証案内メッセージ編集用)

// セキュリティ用データストレージ
const securitySettings = new Map(); // guildId => { enabled: boolean, logChannelId: string, exemptChannels: Set<string> }
const spamTracker = new Map(); // guildId => Map(userId => { mentions: [timestamp], messages: [{id, content, time}] })

// 入退室メッセージ設定
const welcomeSettings = new Map(); // guildId => { channelId, message }
const quitSettings = new Map(); // guildId => { channelId, message }

// ----------------------------------------------------
// データの永続化（再起動対策）
// ----------------------------------------------------
const DB_FILE = path.join(__dirname, 'database.json');

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const content = fs.readFileSync(DB_FILE, 'utf8').trim();
            if (!content) return; // 空ファイルならスキップ
            const data = JSON.parse(content);
            if (data.securitySettings) for (const [k, v] of Object.entries(data.securitySettings)) securitySettings.set(k, { ...v, exemptChannels: new Set(v.exemptChannels) });
            if (data.guildRoles) for (const [k, v] of Object.entries(data.guildRoles)) guildRoles.set(k, v);
            if (data.authMessages) for (const [k, v] of Object.entries(data.authMessages)) authMessages.set(k, v);
            if (data.ticketPanels) for (const [k, v] of Object.entries(data.ticketPanels)) ticketPanels.set(k, v);
            if (data.welcomeSettings) for (const [k, v] of Object.entries(data.welcomeSettings)) welcomeSettings.set(k, v);
            if (data.quitSettings) for (const [k, v] of Object.entries(data.quitSettings)) quitSettings.set(k, v);
            console.log('データベースをロードしました。');
        } catch (e) {
            console.error('データベースロードエラー:', e);
        }
    }
}

function saveDatabase() {
    try {
        const data = {
            securitySettings: Object.fromEntries(Array.from(securitySettings.entries()).map(([k, v]) => [k, { ...v, exemptChannels: Array.from(v.exemptChannels) }])),
            guildRoles: Object.fromEntries(guildRoles.entries()),
            authMessages: Object.fromEntries(authMessages.entries()),
            ticketPanels: Object.fromEntries(ticketPanels.entries()),
            welcomeSettings: Object.fromEntries(welcomeSettings.entries()),
            quitSettings: Object.fromEntries(quitSettings.entries())
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('データベース保存エラー:', e);
    }
}

// ----------------------------------------------------
// 入退室カード生成関数 (Canvas)
// ----------------------------------------------------
// ----------------------------------------------------
// 入退室カード生成関数 (Canvas)
// ----------------------------------------------------

// ----------------------------------------------------
// 円形にくり抜いて画像を描画する補助関数
// ----------------------------------------------------
function drawCircularImage(ctx, image, x, y, radius) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
    ctx.restore();
}

// ----------------------------------------------------
// 入室カード生成関数 (Canvas)
// ----------------------------------------------------
async function createWelcomeCard(member, customMessage) {
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');

    // パステルグラデーション背景
    const grad = ctx.createLinearGradient(0, 0, 1200, 675);
    grad.addColorStop(0, '#d1c4e9');
    grad.addColorStop(0.5, '#b2dfdb');
    grad.addColorStop(1, '#ffccbc');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1200, 675);

    // 背景の装飾の丸
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.arc(1000, 500, 220, 0, Math.PI * 2);
    ctx.fill();

    // ユーザーのアバターアイコンを描画する背景フレーム（左側中央に配置）
    const avatarX = 220;
    const avatarY = 220;
    const avatarRadius = 90;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, avatarRadius + 10, 0, Math.PI * 2);
    ctx.fill();

    // ユーザーのアバターアイコンを描画
    try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        const avatarImage = await loadImage(avatarUrl);
        drawCircularImage(ctx, avatarImage, avatarX, avatarY, avatarRadius);
    } catch (e) {
        console.error('アバター画像の読み込みエラー:', e);
    }

    // 共通の文字スタイル設定（太字・黒縁取りでくっきり）
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#000000';
    ctx.lineWidth = 3;

    // 1行目：[ユーザー名] さん
    const userName = member.user.username;
    ctx.font = `bold 64px ${FONT_FAMILY}`;
    
    // 長い名前がいはみ出さないようにフォントサイズを自動調整
    let nameSize = 64;
    while (ctx.measureText(`${userName} さん`).width > 750 && nameSize > 35) {
        nameSize -= 4;
        ctx.font = `bold ${nameSize}px ${FONT_FAMILY}`;
    }

    const line1Text = `${userName} さん`;
    const line1X = 380; // アイコンの右側からスタート
    const line1Y = 160;
    
    ctx.strokeText(line1Text, line1X, line1Y);
    ctx.fillText(line1Text, line1X, line1Y);

    // 2行目：が [サーバー名] に参加しました！
    const guildName = member.guild.name;
    const line2Text = `が ${guildName} に参加しました！`;
    ctx.font = `bold 48px ${FONT_FAMILY}`;

    // サーバ名が長い場合も考慮して自動調整
    let line2Size = 48;
    while (ctx.measureText(line2Text).width > 780 && line2Size > 30) {
        line2Size -= 4;
        ctx.font = `bold ${line2Size}px ${FONT_FAMILY}`;
    }

    const line2X = 380;
    const line2Y = 260;

    ctx.strokeText(line2Text, line2X, line2Y);
    ctx.fillText(line2Text, line2X, line2Y);

    // 3行目：真ん中下側のカスタムメッセージ（中央寄せ）
    ctx.font = `bold 52px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    
    const customY = 480;
    ctx.strokeText(customMessage, 600, customY);
    ctx.fillText(customMessage, 600, customY);

    return new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome.png' });
}

// ----------------------------------------------------
// 退出カード生成関数 (Canvas)
// ----------------------------------------------------
async function createQuitCard(member, customMessage) {
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 1200, 675);
    grad.addColorStop(0, '#cfd8dc');
    grad.addColorStop(0.5, '#b0bec5');
    grad.addColorStop(1, '#90a4ae');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1200, 675);

    const avatarX = 220;
    const avatarY = 220;
    const avatarRadius = 90;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, avatarRadius + 10, 0, Math.PI * 2);
    ctx.fill();

    try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        const avatarImage = await loadImage(avatarUrl);
        drawCircularImage(ctx, avatarImage, avatarX, avatarY, avatarRadius);
    } catch (e) {
        console.error('アバター画像の読み込みエラー:', e);
    }

    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#000000';
    ctx.lineWidth = 3;

    // 1行目：[ユーザー名] さん
    const userName = member.user.username;
    ctx.font = `bold 64px ${FONT_FAMILY}`;
    
    let nameSize = 64;
    while (ctx.measureText(`${userName} さん`).width > 750 && nameSize > 35) {
        nameSize -= 4;
        ctx.font = `bold ${nameSize}px ${FONT_FAMILY}`;
    }

    const line1Text = `${userName} さん`;
    const line1X = 380;
    const line1Y = 160;
    
    ctx.strokeText(line1Text, line1X, line1Y);
    ctx.fillText(line1Text, line1X, line1Y);

    // 2行目：が [サーバー名] を退出しました。
    const guildName = member.guild.name;
    const line2Text = `が ${guildName} を退出しました。`;
    ctx.font = `bold 48px ${FONT_FAMILY}`;

    let line2Size = 48;
    while (ctx.measureText(line2Text).width > 780 && line2Size > 30) {
        line2Size -= 4;
        ctx.font = `bold ${line2Size}px ${FONT_FAMILY}`;
    }

    const line2X = 380;
    const line2Y = 260;

    ctx.strokeText(line2Text, line2X, line2Y);
    ctx.fillText(line2Text, line2X, line2Y);

    // 3行目：カスタムメッセージ（中央寄せ）
    ctx.font = `bold 52px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    
    const customY = 480;
    ctx.strokeText(customMessage, 600, customY);
    ctx.fillText(customMessage, 600, customY);

    return new AttachmentBuilder(canvas.toBuffer(), { name: 'quit.png' });
}

function updatePresence() {
    const guildCount = client.guilds.cache.size;
    client.user.setActivity({
        name: `導入サーバー数: ${guildCount}サーバー`,
        type: ActivityType.Watching
    });
}

// 違反時のDM＆ログ送信関数
async function handleViolation(member, guild, reason, punishment) {
    try {
        await member.send(
            `# 違反が検知されました\nあなたは${guild.name}で${reason}をしたため、**${punishment}**されました。`
        );
    } catch (e) {
        console.error('DM送信エラー (スパム処罰):', e);
    }
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
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 入退室メッセージ系
    new SlashCommandBuilder()
        .setName('welcome-create')
        .setDescription('入室メッセージカードを設定します（もう一度同じ設定で実行するとオフになります）')
        .addChannelOption(option => option.setName('channel').setDescription('入室メッセージを送信するチャンネル').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption(option => option.setName('message').setDescription('カードに表示するメッセージ').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('quit-create')
        .setDescription('退出メッセージカードを設定します（もう一度同じ設定で実行するとオフになります）')
        .addChannelOption(option => option.setName('channel').setDescription('退出メッセージを送信するチャンネル').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption(option => option.setName('message').setDescription('カードに表示するメッセージ').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.once(Events.ClientReady, async () => {
    loadDatabase(); // 起動時にデータを読み込む
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
                '/welcome-create <チャンネル> <メッセージ> : 入室メッセージカードを設定します！\n' +
                '/quit-create <チャンネル> <メッセージ> : 退出メッセージカードを設定します！'
            );
        }
    } catch (error) {}
});

client.on(Events.GuildDelete, () => updatePresence());

// ----------------------------------------------------
// 入退室イベント検知
// ----------------------------------------------------
client.on(Events.GuildMemberAdd, async member => {
    const setting = welcomeSettings.get(member.guild.id);
    if (!setting) return;
    const channel = member.guild.channels.cache.get(setting.channelId);
    if (!channel) return;

    try {
        const attachment = await createWelcomeCard(member, setting.message);
        await channel.send({
            content: `👋 <@${member.id}> さん、ようこそ！`,
            files: [attachment]
        });
    } catch (e) {
        console.error('入室メッセージ送信エラー:', e);
    }
});

client.on(Events.GuildMemberRemove, async member => {
    const setting = quitSettings.get(member.guild.id);
    if (!setting) return;
    const channel = member.guild.channels.cache.get(setting.channelId);
    if (!channel) return;

    try {
        const attachment = await createQuitCard(member, setting.message);
        await channel.send({
            content: `👋 ${member.user.tag} さんが退出しました。`,
            files: [attachment]
        });
    } catch (e) {
        console.error('退出メッセージ送信エラー:', e);
    }
});

// メンバーのロールが付与されたときの検知（Web認証成功時など）
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const roleName = '認証済み';
    const hadRole = oldMember.roles.cache.some(role => role.name === roleName);
    const hasRole = newMember.roles.cache.some(role => role.name === roleName);

    if (!hadRole && hasRole) {
        const pendingInteraction = pendingAuthInteractions.get(newMember.id);
        if (pendingInteraction) {
            await pendingInteraction.editReply({
                content: '# 認証が完了しました！',
                components: [],
                files: []
            }).catch(() => {});
            pendingAuthInteractions.delete(newMember.id);
        }

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
        userTracker.mentions = last60s;

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

    // 3. 連投スパム検知
    userTracker.messages.push({ id: message.id, content: message.content, time: now });
    userTracker.messages = userTracker.messages.filter(m => now - m.time <= 300000); 

    const recentMessages = userTracker.messages;
    
    const sameContentMsgs = recentMessages.filter(m => m.content === message.content);
    if (sameContentMsgs.length >= 10) {
        const msgIds = sameContentMsgs.map(m => m.id);
        await message.channel.bulkDelete(msgIds).catch(() => {});
        userTracker.messages = recentMessages.filter(m => m.content !== message.content);
        if (member && member.manageable) {
            await member.timeout(60 * 60 * 1000, '同じ言葉を10回連投したため').catch(() => {});
            await handleViolation(member, message.guild, '同じ言葉を10回連投した', '1時間タイムアウト');
        }
        return;
    }

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
                saveDatabase();
                return interaction.reply({ content: '✅ スパム・荒らし対策モードを **オン** にしました。', flags: MessageFlags.Ephemeral });
            } 
            else if (commandName === 'security-off') {
                settings.enabled = false;
                saveDatabase();
                return interaction.reply({ content: '⚠️ スパム・荒らし対策モードを **オフ** にしました。', flags: MessageFlags.Ephemeral });
            }
            else if (commandName === 'security-channel-off') {
                const channel = interaction.options.getChannel('channel');
                settings.exemptChannels.add(channel.id);
                saveDatabase();
                return interaction.reply({ content: `✅ ${channel} を対策の監視対象から **除外** しました。`, flags: MessageFlags.Ephemeral });
            }
            else if (commandName === 'security-channel-on') {
                const channel = interaction.options.getChannel('channel');
                settings.exemptChannels.delete(channel.id);
                saveDatabase();
                return interaction.reply({ content: `✅ ${channel} の除外を解除し、監視対象に **戻し** ました。`, flags: MessageFlags.Ephemeral });
            }
            else if (commandName === 'security-log') {
                const channel = interaction.options.getChannel('channel');
                settings.logChannelId = channel.id;
                saveDatabase();
                return interaction.reply({ content: `✅ 違反ログの送信先を ${channel} に設定しました。`, flags: MessageFlags.Ephemeral });
            }
        }

        // --- 入退室設定コマンド ---
        else if (commandName === 'welcome-create') {
            const channel = interaction.options.getChannel('channel');
            const messageText = interaction.options.getString('message');

            const current = welcomeSettings.get(guildId);
            if (current && current.channelId === channel.id && current.message === messageText) {
                welcomeSettings.delete(guildId);
                saveDatabase();
                return interaction.reply({ content: '✅ 入室メッセージ機能を **オフ** にしました。', flags: MessageFlags.Ephemeral });
            }

            welcomeSettings.set(guildId, { channelId: channel.id, message: messageText });
            saveDatabase();
            return interaction.reply({ content: `✅ 入室メッセージを ${channel} に設定しました！\nメッセージ: ${messageText}\n(もう一度同じ設定で実行するとオフになります)`, flags: MessageFlags.Ephemeral });
        }
        else if (commandName === 'quit-create') {
            const channel = interaction.options.getChannel('channel');
            const messageText = interaction.options.getString('message');

            const current = quitSettings.get(guildId);
            if (current && current.channelId === channel.id && current.message === messageText) {
                quitSettings.delete(guildId);
                saveDatabase();
                return interaction.reply({ content: '✅ 退出メッセージ機能を **オフ** にしました。', flags: MessageFlags.Ephemeral });
            }

            quitSettings.set(guildId, { channelId: channel.id, message: messageText });
            saveDatabase();
            return interaction.reply({ content: `✅ 退出メッセージを ${channel} に設定しました！\nメッセージ: ${messageText}\n(もう一度同じ設定で実行するとオフになります)`, flags: MessageFlags.Ephemeral });
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
                saveDatabase();
                await interaction.reply({ content: '認証メッセージを設置しました！', flags: MessageFlags.Ephemeral });
            } catch (error) {
                await interaction.reply({ content: 'エラーが発生しました。Botの権限を確認してください。', flags: MessageFlags.Ephemeral });
            }
        } 
        else if (commandName === 'auth-delete') {
            const messageId = authMessages.get(guildId);
            if (!messageId) return interaction.reply({ content: '認証メッセージが見つかりません。', flags: MessageFlags.Ephemeral });
            let deleted = false;
            for (const channel of interaction.guild.channels.cache.values()) {
                if (!channel.isTextBased()) continue;
                try {
                    const msg = await channel.messages.fetch(messageId);
                    if (msg) { await msg.delete(); deleted = true; break; }
                } catch (e) {}
            }
            authMessages.delete(guildId);
            saveDatabase();
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
            const authRoleId = guildRoles.get(interaction.guildId) || interaction.guild.roles.cache.find(r => r.name === '認証済み')?.id;
            if (authRoleId && interaction.member.roles.cache.has(authRoleId)) {
                return interaction.reply({ content: '# 認証完了\nあなたは既に認証が完了しています！', flags: MessageFlags.Ephemeral });
            }

            const token = crypto.randomBytes(32).toString('hex');
            
            try {
                const response = await fetch('https://hiromu0623-discord-auth.pages.dev/api/verify', {
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register', token: token, guildId: interaction.guildId, userId: interaction.user.id })
                });
                const result = await response.json();
                if (!result.success) {
                    return interaction.reply({ content: '認証の初期化に失敗しました。', flags: MessageFlags.Ephemeral });
                }
            } catch (err) {
                return interaction.reply({ content: '通信エラーが発生しました。', flags: MessageFlags.Ephemeral });
            }

            const authUrl = `https://hiromu0623-discord-auth.pages.dev/auth/?token=${token}`;
            const linkRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('サイトを開く').setStyle(ButtonStyle.Link).setURL(authUrl),
                new ButtonBuilder().setCustomId('alt_auth_btn').setLabel('別の方法').setStyle(ButtonStyle.Primary)
            );

            await interaction.reply({
                content: '認証用のリンクを発行しました！以下のリンクからログインを進めてください',
                components: [linkRow],
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 2. 別の方法（画像認証生成）ボタン
        else if (interaction.customId === 'alt_auth_btn') {
            await interaction.deferUpdate();

            const captcha = new Captcha();
            captcha.async = false;
            captcha.addDecoy();
            captcha.drawTrace();
            captcha.drawCaptcha();

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

            const permissionOverwrites = [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ];
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
                
                const deleteBtnRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('delete_ticket_btn')
                        .setLabel('チケットを削除')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🗑️')
                );

                await ticketChannel.send({
                    content: `<@${interaction.user.id}> チケットを作成しました。用件をご入力ください。`,
                    components: [deleteBtnRow]
                });
            } catch (error) {
                console.error(error);
                await interaction.reply({ content: 'チケットの作成に失敗しました。', flags: MessageFlags.Ephemeral });
            }
        }

        // 5. チケット内の削除ボタン
        else if (interaction.customId === 'delete_ticket_btn') {
            await interaction.reply({ content: 'このチケット（チャンネル）を削除します...', flags: MessageFlags.Ephemeral });
            setTimeout(() => interaction.channel.delete().catch(()=>{}), 2000);
        }
    }

    // --- モーダル送信処理 ---
    else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'captcha_answer_modal') {
            const answer = interaction.fields.getTextInputValue('captcha_answer_input');
            const correctAnswer = captchaStore.get(interaction.user.id);

            if (answer === correctAnswer) {
                const authRoleId = guildRoles.get(interaction.guildId) || interaction.guild.roles.cache.find(r => r.name === '認証済み')?.id;
                if (authRoleId) {
                    await interaction.member.roles.add(authRoleId).catch(console.error);
                }
                captchaStore.delete(interaction.user.id);

                const pendingInteraction = pendingAuthInteractions.get(interaction.user.id);
                if (pendingInteraction) {
                    await pendingInteraction.editReply({
                        content: '# 認証が完了しました！',
                        components: [],
                        files: []
                    }).catch(() => {});
                    pendingAuthInteractions.delete(interaction.user.id);
                }

                await interaction.reply({ content: '画像認証に成功しました！ロールを付与しました。', flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ content: '暗号が間違っています。「別の方法」または「回答」ボタンからやり直してください。', flags: MessageFlags.Ephemeral });
            }
        }

        else if (interaction.customId === 'ticket_create_modal') {
            const title = interaction.fields.getTextInputValue('ticket_title');
            const desc = interaction.fields.getTextInputValue('ticket_desc');
            const rolesStr = interaction.fields.getTextInputValue('ticket_roles');
            
            const roleIds = rolesStr ? rolesStr.split(',').map(id => id.trim()).filter(id => id.length > 0) : [];

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('create_ticket_btn').setLabel('チケットを作成').setStyle(ButtonStyle.Success).setEmoji('🎫')
            );

            const panelMessage = await interaction.channel.send({
                content: `# ${title}\n## ${desc}`,
                components: [row]
            });

            ticketPanels.set(panelMessage.id, roleIds);
            saveDatabase();

            await interaction.reply({ content: 'チケットパネルを生成しました。', flags: MessageFlags.Ephemeral });
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);

// Render等のタイムアウト回避用Webサーバー
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// JSONリクエストをパースできるようにする
app.use(express.json());

app.get('/', (req, res) => res.send('Bot is running!'));

// 認証の成功・失敗ログを受信するAPIエンドポイント
app.post('/api/auth-log', async (req, res) => {
    const { guildId, userId, success, ip, userAgent, error } = req.body;
    
    if (!guildId) {
        return res.status(400).json({ success: false, error: 'guildId is required' });
    }

    // サーバーのセキュリティ設定からログチャンネルを取得
    const settings = securitySettings.get(guildId);
    if (settings && settings.logChannelId) {
        const channel = client.channels.cache.get(settings.logChannelId);
        if (channel) {
            const userMention = userId ? `<@${userId}> (${userId})` : '不明なユーザー';
            const clientIp = ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '不明';
            const ua = userAgent || req.headers['user-agent'] || '不明';

            if (success) {
                // 認証成功時のログ
                await channel.send(
                    `✅ **認証成功ログ**\n` +
                    `👤 ユーザー: ${userMention}\n` +
                    `🌐 ネットワークID (IP): \`${clientIp}\`\n` +
                    `💻 ブラウザ情報: \`${ua}\``
                ).catch(() => {});
            } else {
                // 認証失敗時のログ（詳細・ネットワークID付き）
                await channel.send(
                    `❌ **認証失敗ログ**\n` +
                    `👤 ユーザー: ${userMention}\n` +
                    `⚠️ 理由: ${error || '不明なエラー'}\n` +
                    `🌐 ネットワークID (IP): \`${clientIp}\`\n` +
                    `💻 ブラウザ情報: \`${ua}\``
                ).catch(() => {});
            }
        }
    }

    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Web server is running on port ${PORT}`));
