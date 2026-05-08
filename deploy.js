const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./utils/load-env');
loadEnv();

const rawConsoleError = console.error.bind(console);
const rawConsoleWarn = console.warn.bind(console);
console.error = (...args) => {
    rawConsoleError('[Error \u274C] An error occoured.. standby...');
    rawConsoleError(...args);
};
console.warn = (...args) => {
    rawConsoleWarn('[Warning \u26A0\uFE0F]');
    rawConsoleWarn(...args);
};

function deployLog(message) {
    console.log('[Deploying \u{1F504}\uFE0F] ' + message);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if (command.data) {
        commands.push(command.data.toJSON());
    }
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        deployLog('Started refreshing application (/) commands globally.');
        await rest.put(
            Routes.applicationCommands(process.env.APP_ID),
            { body: commands }
        );
        deployLog('Successfully reloaded application (/) commands globally.');
    } catch (error) {
        console.error('[Deploying \u{1F504}\uFE0F] Command deployment failed:', error);
    }
})();
