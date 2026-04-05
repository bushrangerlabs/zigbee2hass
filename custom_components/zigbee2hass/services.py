"""HA services for Zigbee2HASS.

Registers the following HA services:

  zigbee2hass.permit_join        - open/close network for new devices
  zigbee2hass.ping_device        - ping a device, get latency in ms
  zigbee2hass.backup             - trigger immediate NVRam backup
  zigbee2hass.migrate_from_z2m  - import a Z2M data directory
  zigbee2hass.restart_addon      - restart the Zigbee controller in the add-on
"""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .coordinator import Zigbee2HASSCoordinator

_LOGGER = logging.getLogger(__name__)

SERVICE_PERMIT_JOIN   = "permit_join"
SERVICE_PING_DEVICE   = "ping_device"
SERVICE_BACKUP        = "backup"
SERVICE_MIGRATE_Z2M   = "migrate_from_z2m"
SERVICE_RESTART       = "restart_addon"

SCHEMA_PERMIT_JOIN = vol.Schema({
    vol.Optional("permit", default=True): cv.boolean,
    vol.Optional("timeout", default=254): vol.All(int, vol.Range(min=1, max=254)),
})

SCHEMA_PING_DEVICE = vol.Schema({
    vol.Required("ieee_address"): cv.string,
})

SCHEMA_MIGRATE_Z2M = vol.Schema({
    vol.Required("z2m_data_dir"): cv.string,
})


def async_register_services(hass: HomeAssistant) -> None:
    """Register all Zigbee2HASS services."""

    def _get_coordinator(call: ServiceCall) -> Zigbee2HASSCoordinator:
        """Get the first available coordinator, skipping non-coordinator domain keys."""
        domain_data = hass.data.get(DOMAIN, {})
        entry_id = next(
            (k for k, v in domain_data.items() if isinstance(v, Zigbee2HASSCoordinator)),
            None,
        )
        if not entry_id:
            raise ValueError("No Zigbee2HASS integration configured")
        return domain_data[entry_id]

    async def handle_permit_join(call: ServiceCall) -> None:
        coordinator = _get_coordinator(call)
        permit  = call.data.get("permit", True)
        timeout = call.data.get("timeout", 254)
        await coordinator.async_permit_join(permit, timeout)
        _LOGGER.info("Permit join set to %s (timeout %ds)", permit, timeout)

    async def handle_ping_device(call: ServiceCall) -> None:
        coordinator  = _get_coordinator(call)
        ieee_address = call.data["ieee_address"]
        latency      = await coordinator.async_ping_device(ieee_address)
        _LOGGER.info("Ping %s: %dms", ieee_address, latency)

    async def handle_backup(call: ServiceCall) -> None:
        coordinator = _get_coordinator(call)
        path = await coordinator.async_backup()
        _LOGGER.info("NVRam backup saved: %s", path)

    async def handle_migrate_z2m(call: ServiceCall) -> None:
        coordinator  = _get_coordinator(call)
        z2m_data_dir = call.data["z2m_data_dir"]
        result = await coordinator.async_migrate_z2m(z2m_data_dir)
        _LOGGER.info("Z2M migration result: %s", result)

    async def handle_restart(call: ServiceCall) -> None:
        coordinator = _get_coordinator(call)
        await coordinator._client.request("restart")
        _LOGGER.info("Zigbee controller restart requested")

    hass.services.async_register(DOMAIN, SERVICE_PERMIT_JOIN,  handle_permit_join,  SCHEMA_PERMIT_JOIN)
    hass.services.async_register(DOMAIN, SERVICE_PING_DEVICE,  handle_ping_device,  SCHEMA_PING_DEVICE)
    hass.services.async_register(DOMAIN, SERVICE_BACKUP,       handle_backup)
    hass.services.async_register(DOMAIN, SERVICE_MIGRATE_Z2M,  handle_migrate_z2m,  SCHEMA_MIGRATE_Z2M)
    hass.services.async_register(DOMAIN, SERVICE_RESTART,      handle_restart)

    _LOGGER.debug("Zigbee2HASS services registered")


def async_unregister_services(hass: HomeAssistant) -> None:
    """Unregister all Zigbee2HASS services."""
    for service in (SERVICE_PERMIT_JOIN, SERVICE_PING_DEVICE, SERVICE_BACKUP, SERVICE_MIGRATE_Z2M, SERVICE_RESTART):
        hass.services.async_remove(DOMAIN, service)
