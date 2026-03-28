"""Config flow for Zigbee2HASS."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.config_entries import ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT

from .const import DOMAIN, DEFAULT_PORT

_LOGGER = logging.getLogger(__name__)

STEP_USER_DATA_SCHEMA = vol.Schema({
    vol.Required(CONF_HOST, default="c37b87b9-zigbee2hass"): str,
    vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
})


class Zigbee2HASSConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Zigbee2HASS."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the initial step."""
        if user_input is not None:
            host = user_input[CONF_HOST]
            port = user_input[CONF_PORT]

            # Check for duplicate entry
            await self.async_set_unique_id(f"{host}:{port}")
            self._abort_if_unique_id_configured()

            return self.async_create_entry(
                title=f"Zigbee2HASS ({host}:{port})",
                data={CONF_HOST: host, CONF_PORT: port},
            )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            description_placeholders={"default_port": str(DEFAULT_PORT)},
        )

    async def async_step_hassio(self, discovery_info: Any) -> ConfigFlowResult:
        """Handle add-on auto-discovery via the Supervisor."""
        # When installed as an HA add-on, the Supervisor can auto-discover it
        host = discovery_info.config.get("host", "localhost")
        port = discovery_info.config.get("websocket_port", DEFAULT_PORT)

        await self.async_set_unique_id(f"{host}:{port}")
        self._abort_if_unique_id_configured()

        self.context["title_placeholders"] = {"host": host, "port": port}
        self._discovery_data = {CONF_HOST: host, CONF_PORT: port}

        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input: dict | None = None) -> ConfigFlowResult:
        """Confirm add-on discovery."""
        if user_input is not None:
            return self.async_create_entry(
                title="Zigbee2HASS",
                data=self._discovery_data,
            )
        return self.async_show_form(step_id="hassio_confirm")

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle reconfiguration (allows fixing host/port on an existing entry)."""
        if user_input is not None:
            host = user_input[CONF_HOST]
            port = user_input[CONF_PORT]

            return self.async_update_reload_and_abort(
                self._get_reconfigure_entry(),
                data_updates={CONF_HOST: host, CONF_PORT: port},
            )

        entry = self._get_reconfigure_entry()
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema({
                vol.Required(CONF_HOST, default=entry.data.get(CONF_HOST, "c37b87b9-zigbee2hass")): str,
                vol.Required(CONF_PORT, default=entry.data.get(CONF_PORT, DEFAULT_PORT)): int,
            }),
        )
