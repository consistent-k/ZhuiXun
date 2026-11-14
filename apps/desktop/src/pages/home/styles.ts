import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css }) => {
    return css({
        '&.home-page': {
            flex: 1,
            display: 'flex',
            minWidth: 0,

            '& .home-page-background-streams': {
                position: 'fixed',
                bottom: 24,
                right: 24
            }
        }
    });
});

export default useStyles;
