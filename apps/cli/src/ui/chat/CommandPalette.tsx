import { Box, Text } from 'ink';
import React from 'react';

import type { Choice } from '../../completion';
import { t } from '../../i18n';
import { useTheme } from '../text/theme';

interface CommandPaletteProps {
    commands: Choice[];
    selectedIndex: number;
}

export function CommandPalette({ commands, selectedIndex }: CommandPaletteProps) {
    const { theme } = useTheme();

    if (commands.length === 0) {
        return (
            <Box paddingX={1}>
                <Text color={theme.inactive}>{t('ui.commandPalette.noMatch')}</Text>
            </Box>
        );
    }

    return (
        <>
            {commands.map((cmd, i) => (
                <Box key={cmd.value} paddingX={1}>
                    <Box width={2}>
                        <Text color={i === selectedIndex ? theme.suggestion : undefined}>
                            {i === selectedIndex ? '❯' : ' '}
                        </Text>
                    </Box>
                    <Box width={25}>
                        <Text>{cmd.label}</Text>
                    </Box>
                    <Box>
                        <Text dimColor>{cmd.description}</Text>
                    </Box>
                </Box>
            ))}
        </>
    );
}
