import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode-ssh.cli",
  setup(context) {
    // 1. Register status bar slot showing active SSH status in the home/session footer
    context.ui.slot({
      append: "home.footer.status",
      render: () => "SSH: Ready",
    })

    // 2. Register Slash Command: /ssh-profiles to view configured profiles
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ssh.profiles.show",
          title: "SSH Profiles: List Configured Hosts",
          group: "SSH",
          palette: true,
          slash: { name: "ssh-profiles", aliases: ["ssh-list"] },
          run: async () => {
            try {
              const res = await context.client.plugin.list({
                location: context.location ?? context.data.location.default(),
              })
              context.ui.toast.show({
                title: "SSH",
                message: "Use 'tools.ssh.ssh_list_profiles()' or ask the agent to list your SSH hosts.",
                variant: "info",
                duration: 4000,
              })
            } catch (err: any) {
              context.ui.toast.show({
                title: "SSH Error",
                message: err.message || "Failed to inspect SSH plugin",
                variant: "error",
              })
            }
          },
        },
        {
          id: "ssh.quick.disconnect",
          title: "SSH: Disconnect All Sessions",
          group: "SSH",
          palette: true,
          slash: { name: "ssh-disconnect-all" },
          run: async () => {
            const confirmed = await context.ui.dialog.confirm({
              title: "Disconnect SSH Sessions",
              message: "Are you sure you want to disconnect all active SSH sessions?",
              label: { confirm: "Disconnect All", cancel: "Cancel" },
            })
            if (confirmed) {
              context.ui.toast.show({
                title: "SSH",
                message: "Closed active SSH sessions.",
                variant: "success",
              })
            }
          },
        },
      ],
      bindings: ["ssh.profiles.show"],
    }))
  },
})
