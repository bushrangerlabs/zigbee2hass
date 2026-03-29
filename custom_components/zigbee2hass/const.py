"""Constants for Zigbee2HASS."""

DOMAIN = "zigbee2hass"

# WebSocket topics from the add-on
TOPIC_BRIDGE_STATE      = "zigbee2hass/bridge/state"
TOPIC_BRIDGE_DEVICES    = "zigbee2hass/bridge/devices"
TOPIC_BRIDGE_COORD      = "zigbee2hass/bridge/coordinator"
TOPIC_BRIDGE_BACKUP     = "zigbee2hass/bridge/backup"
TOPIC_DEVICE_STATE      = "zigbee2hass/device/state"
TOPIC_DEVICE_AVAIL      = "zigbee2hass/device/availability"
TOPIC_DEVICE_JOINED     = "zigbee2hass/device/joined"
TOPIC_DEVICE_LEFT       = "zigbee2hass/device/left"
TOPIC_DEVICE_READY      = "zigbee2hass/device/ready"
TOPIC_DEVICE_RENAMED    = "zigbee2hass/device/renamed"
TOPIC_PERMIT_JOIN       = "zigbee2hass/permitjoin"
TOPIC_ERROR             = "zigbee2hass/error"

# Config entry keys
CONF_HOST = "host"
CONF_PORT = "port"
DEFAULT_PORT = 8756

# Expose feature types (from zigbee-herdsman-converters)
EXPOSE_LIGHT    = "light"
EXPOSE_SWITCH   = "switch"
EXPOSE_SENSOR   = "numeric"
EXPOSE_BINARY   = "binary"
EXPOSE_ENUM     = "enum"
EXPOSE_COVER    = "cover"
EXPOSE_CLIMATE  = "climate"
EXPOSE_LOCK     = "lock"
EXPOSE_FAN      = "fan"
EXPOSE_COMPOSITE = "composite"
