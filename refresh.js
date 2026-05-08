const { REST, Routes } = require('discord.js');
const { loadEnv } = require('./utils/load-env');
loadEnv();

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('Started clearing application (/) commands globally.');

        await rest.put(
            Routes.applicationCommands(process.env.APP_ID),
            { body: [] }
        );

        console.log('Successfully cleared application (/) commands globally.');
    } catch (error) {
        console.error(error);
    }
})();
