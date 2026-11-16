#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

static pid_t parse_pid(const char *arg) {
    char *end;
    errno = 0;
    long value = strtol(arg, &end, 10);
    if (errno || end == arg || *end || value <= 1 || value > INT_MAX)
        return 0;
    return (pid_t)value;
}

static int add_rss(pid_t pid, uint64_t *total) {
    struct proc_taskinfo task;
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, sizeof(task));
    if (bytes == 0 && errno == ESRCH) return 0;
    if (bytes != sizeof(task)) {
        fprintf(stderr, "Cannot read RSS for process %d: %s\n", pid,
                errno ? strerror(errno) : "incomplete task information");
        return 1;
    }
    *total += task.pti_resident_size;
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts(OPENCUT_VERSION);
        return 0;
    }
    if (argc < 3) return 2;
    uint64_t total = 0;
    if (strcmp(argv[1], "group") == 0) {
        pid_t group = parse_pid(argv[2]);
        if (!group || argc != 3) return 2;
        // Only enumerate the detached recipe group. A full buffer may be
        // truncated, so fail closed instead of reporting a partial sample.
        pid_t pids[4096];
        errno = 0;
        int count = proc_listpgrppids(group, pids, sizeof(pids));
        if (count < 0 || (count == 0 && errno) ||
            count >= (int)(sizeof(pids) / sizeof(pids[0]))) {
            fprintf(stderr, "Cannot list recipe process group %d: %s\n", group,
                    errno ? strerror(errno) : "process limit exceeded");
            return 1;
        }
        for (int index = 0; index < count; index++)
            if (add_rss(pids[index], &total)) return 1;
    } else if (strcmp(argv[1], "pids") == 0) {
        for (int index = 2; index < argc; index++) {
            pid_t pid = parse_pid(argv[index]);
            if (!pid) return 2;
            if (add_rss(pid, &total)) return 1;
        }
    } else return 2;
    printf("%" PRIu64 "\n", total);
    return 0;
}
