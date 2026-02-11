
let recentActivity = [];

const MessageType = {
    MOD_REGISTERED: "New Mod Registered: %s", // mod_name
    SERVER_HEARTBEAT: "Server Heartbeat: %s players online (ID: %a)", // player count, server uuid
    SERVER_START_TRACKING: "Started tracking server with ID: %s", // server uuid
    MOD_REGISTERED_TO_SERVER: "Mod %s registered to server %a" // mod name, mod version, server uuid
};

function addToRecentActivity(type, data) {
    const timestamp = Date.now();

    const message = (() => {
        switch (type) {
            case MessageType.MOD_REGISTERED:
                return MessageType.MOD_REGISTERED.replace("%s", data.mod_name);
            case MessageType.SERVER_HEARTBEAT:
                return MessageType.SERVER_HEARTBEAT.replace("%s", data.player_count).replace("%a", data.server_uuid);
            case MessageType.SERVER_START_TRACKING:
                return MessageType.SERVER_START_TRACKING.replace("%s", data.server_uuid);
            case MessageType.MOD_REGISTERED_TO_SERVER:
                return MessageType.MOD_REGISTERED_TO_SERVER.replace("%s", data.mod_name).replace("%a", data.server_uuid);
            default:
                return null;
        }
    })();

    if (!message) {
        return;
    }

    recentActivity.push({ message, timestamp });

    // keep only the last 4 entries    
    if (recentActivity.length > 4) {
        recentActivity.shift();
    }
}

function getRecentActivity() {
    // return a copy of the recent activity array, sorted by timestamp descending
    return recentActivity.slice().sort((a, b) => b.timestamp - a.timestamp);
}

export {
    addToRecentActivity,
    getRecentActivity,
    MessageType
}