const cloneModes = {
  fork: [
    {
      title: "주소 공간",
      text: "새 mm_struct를 만들고 uvmcopy()로 부모 주소 공간을 복사합니다."
    },
    {
      title: "thread group",
      text: "child는 자기 자신이 group leader입니다. tgid는 child pid가 됩니다."
    },
    {
      title: "return value",
      text: "부모에게는 child pid, child에게는 a0=0으로 clone()이 돌아옵니다."
    }
  ],
  thread: [
    {
      title: "주소 공간",
      text: "부모의 mm_struct를 공유하고 mm_get()으로 refcount를 증가시킵니다."
    },
    {
      title: "trapframe",
      text: "공유 page table 안에서 빈 tf_va slot을 찾아 새 trapframe page를 mapping합니다."
    },
    {
      title: "시작 지점",
      text: "epc=fn, a0=arg, sp=stack+n_pages*PGSIZE로 맞춘 뒤 RUNNABLE로 둡니다."
    }
  ]
};

const codeSections = {
  memory: {
    title: "memory helpers: 공유 주소 공간의 lifetime",
    summary: "thread가 같은 page table을 공유하므로, 주소 공간의 생성과 해제를 proc lifetime과 분리해야 합니다.",
    snippet: `void
mm_get(struct mm_struct *mm)
{
  acquire(&mm->lock);
  mm->refcount++;
  release(&mm->lock);
}

void
mm_put(struct mm_struct *mm)
{
  acquire(&mm->lock);
  mm->refcount--;
  if(mm->refcount > 0){
    release(&mm->lock);
    return;
  }
  pagetable = mm->pagetable;
  sz = mm->sz;
  release(&mm->lock);
  proc_freepagetable(pagetable, sz);
  kfree(mm);
}`,
    points: [
      ["mm_get", "새 thread가 부모 mm을 공유하기 시작할 때 refcount를 올립니다."],
      ["mm_put", "task가 회수될 때 refcount를 내리고 마지막 참조에서만 page table을 지웁니다."],
      ["freeproc", "trapframe mapping을 먼저 uvmunmap하고 physical trapframe을 따로 kfree합니다."]
    ],
    details: [
      ["mm_alloc()", "새 주소 공간을 대표하는 mm_struct를 만들고 refcount를 1로 시작합니다. 처음에는 이 주소 공간을 쓰는 proc가 하나뿐이라는 뜻입니다."],
      ["mm_get(mm)", "새 thread가 부모의 mm_struct를 같이 쓰기 시작할 때 호출합니다. 쉽게 말해 '이 주소 공간을 쓰는 사람이 하나 늘었다'고 표시합니다."],
      ["mm_put(mm)", "proc 하나가 사라질 때 호출합니다. refcount를 하나 줄이고, 아직 1 이상이면 다른 thread가 쓰는 중이므로 아무것도 free하지 않습니다."],
      ["refcount == 0", "마지막 사용자가 사라졌다는 뜻입니다. 이때만 page table과 mm_struct를 해제해야 남아 있는 thread가 죽은 주소 공간을 보는 일이 없습니다."],
      ["freeproc()", "proc 자체를 정리하는 함수입니다. thread마다 따로 가진 trapframe mapping을 먼저 지우고, physical trapframe page를 kfree한 다음 mm_put()으로 주소 공간 참조를 내려놓습니다."]
    ]
  },
  clone: {
    title: "kclone: fork path와 thread path의 분기",
    summary: "하나의 kernel 함수가 flags에 따라 process 생성과 thread 생성을 모두 처리합니다.",
    snippet: `if(flags & CLONE_VM){
  if(stack == 0 || n_pages <= 0)
    goto fail;

  np->mm = p->mm;
  mm_get(np->mm);

  np->tf_va = find_free_tf_va(np->mm->pagetable);
  mappages(np->mm->pagetable, np->tf_va, PGSIZE,
           (uint64)np->trapframe, PTE_R | PTE_W);

  np->group_leader = p->group_leader;
  np->tgid = p->tgid;
  np->ustack = (void *)stack;
  np->trapframe->epc = fn;
  np->trapframe->a0 = arg;
  np->trapframe->sp = stack + n_pages * PGSIZE;
} else {
  np->mm = mm_alloc();
  proc_pagetable(np);
  uvmcopy(p->mm->pagetable, np->mm->pagetable, p->mm->sz);
  np->group_leader = np;
  np->tgid = np->pid;
}`,
    points: [
      ["CLONE_VM", "주소 공간은 복사하지 않고 공유합니다."],
      ["trapframe slot", "thread마다 고유한 tf_va를 찾아 register 저장 위치를 분리합니다."],
      ["fork from thread", "non-leader가 fork해도 child는 새 thread group의 leader가 됩니다."]
    ],
    details: [
      ["if(flags & CLONE_VM)", "CLONE_VM 비트가 있으면 thread 생성 경로입니다. 새 proc를 만들지만 주소 공간은 부모와 같이 씁니다."],
      ["stack == 0 || n_pages <= 0", "thread는 자기 user stack이 필요합니다. stack 주소가 없거나 크기가 0 page 이하이면 시작할 공간이 없으므로 실패합니다."],
      ["np->mm = p->mm", "새 thread np가 부모 p의 mm_struct를 그대로 가리키게 합니다. 이 한 줄 때문에 heap과 global이 공유됩니다."],
      ["mm_get(np->mm)", "같은 mm_struct를 쓰는 proc가 하나 늘었으므로 refcount를 증가시킵니다. 나중에 한 thread가 먼저 끝나도 주소 공간이 너무 일찍 free되지 않게 합니다."],
      ["find_free_tf_va(...)", "thread들은 page table을 공유하지만 trapframe은 각자 따로 필요합니다. 그래서 공유 page table 안에서 비어 있는 trapframe VA slot을 찾습니다."],
      ["mappages(...)", "찾은 tf_va slot을 새 thread의 physical trapframe page에 연결합니다. 이제 이 thread는 자기 slot을 통해 자기 register 저장 공간을 찾을 수 있습니다."],
      ["group_leader / tgid", "새 thread는 부모와 같은 thread group에 들어갑니다. pid는 thread마다 다르지만 tgid는 같은 process 묶음을 나타냅니다."],
      ["ustack", "user library가 malloc으로 만든 stack base를 기억합니다. thread가 끝난 뒤 join이 이 주소를 user에게 돌려줘야 free할 수 있습니다."],
      ["epc = fn", "새 thread가 user mode로 돌아갔을 때 fn 함수부터 실행하게 합니다. epc는 다시 실행할 코드 위치입니다."],
      ["a0 = arg", "RISC-V에서 첫 번째 함수 인자는 a0 register로 전달됩니다. 그래서 fn(arg)처럼 시작하려면 a0에 arg를 넣어둡니다."],
      ["sp = stack + n_pages * PGSIZE", "stack은 높은 주소에서 낮은 주소로 자라므로 시작 sp는 할당받은 stack의 맨 위로 둡니다."],
      ["else", "CLONE_VM이 없으면 fork 경로입니다. 주소 공간을 공유하지 않고 새 mm_struct와 새 page table을 만듭니다."],
      ["mm_alloc() / proc_pagetable()", "child process가 사용할 새 주소 공간과 새 page table을 준비합니다."],
      ["uvmcopy(...)", "부모의 주소 공간 내용을 child의 새 page table로 복사합니다. 처음 값은 같지만 이후에는 서로 다른 physical memory를 봅니다."],
      ["np->group_leader = np", "fork로 만들어진 child는 독립 process입니다. 그래서 child 자신이 새 thread group의 leader가 됩니다."],
      ["np->tgid = np->pid", "독립 process의 thread group id는 자기 pid와 같습니다."]
    ]
  },
  joinwait: {
    title: "kjoin / kwait: thread와 process 회수 분리",
    summary: "wait이 thread zombie를 가져가면 user stack을 free할 기회가 사라집니다. 그래서 join과 wait 대상은 분리됩니다.",
    snippet: `// join: same group, non-leader zombie
if(pp->group_leader == p->group_leader &&
   pp->group_leader != pp &&
   pp->state == ZOMBIE){
  stack = (uint64)pp->ustack;
  copyout(p->mm->pagetable, stack_addr,
          (char *)&stack, sizeof(stack));
  freeproc(pp);
}

// wait: child 중 group leader만
if(pp->parent == p && pp->group_leader == pp &&
   pp->state == ZOMBIE){
  copyout(p->mm->pagetable, addr,
          (char *)&pp->xstate, sizeof(pp->xstate));
  freeproc(pp);
}`,
    points: [
      ["join", "같은 group의 non-leader zombie를 기다리고 stack base를 user로 돌려줍니다."],
      ["thread_join", "join이 돌려준 stack을 user library가 free합니다."],
      ["wait", "process child만 회수하도록 group leader 조건을 둡니다."]
    ],
    details: [
      ["pp->group_leader == p->group_leader", "join은 나와 같은 thread group 안에 있는 thread를 찾습니다. 같은 process 안의 동료 thread인지 확인하는 조건입니다."],
      ["pp->group_leader != pp", "leader가 아닌 일반 thread만 join 대상입니다. leader는 process 대표이므로 wait 쪽에서 부모 process가 회수합니다."],
      ["pp->state == ZOMBIE", "이미 실행은 끝났지만 아직 proc 구조체가 정리되지 않은 thread만 회수할 수 있습니다."],
      ["stack = pp->ustack", "종료된 thread가 사용하던 user stack base를 꺼냅니다. 이 stack은 user malloc으로 만든 것이므로 user 쪽에서 free해야 합니다."],
      ["copyout(... stack ...)", "kernel 내부 값인 stack 주소를 user memory의 stack_addr 위치에 써줍니다. user의 thread_join()은 이 값을 받아 free(stack)을 호출합니다."],
      ["freeproc(pp)", "thread의 proc, trapframe, mm 참조를 정리합니다. 단, user stack 자체는 kernel이 free하지 않습니다."],
      ["pp->parent == p", "wait은 내가 fork로 만든 child process를 찾습니다. 같은 group의 sibling thread를 찾는 join과 출발점이 다릅니다."],
      ["pp->group_leader == pp", "wait은 child 중에서도 process 대표만 회수합니다. 이 조건이 없으면 wait이 thread zombie를 가져가 stack 주소를 잃어버릴 수 있습니다."],
      ["copyout(... xstate ...)", "wait은 stack 주소가 아니라 child의 exit status를 user의 status 변수에 써줍니다."],
      ["join vs wait", "join은 thread 회수와 stack 반환, wait은 child process 회수와 exit status 반환입니다. 둘을 섞으면 stack leak이나 잘못된 회수가 생깁니다."]
    ]
  },
  wide: {
    title: "exit / kill / exec: process-wide system call 조정",
    summary: "thread group에서는 한 task의 system call이 전체 주소 공간에 영향을 줄 수 있으므로 의미를 다시 정의해야 합니다.",
    snippet: `// leader exit
if(p->group_leader == p)
  drain_siblings(p);

// kill(pid): pid가 thread여도 group 전체
if(p->state != UNUSED &&
   (p->group_leader == leader || p->tgid == tgid)){
  p->killed = 1;
  if(p->state == SLEEPING)
    p->state = RUNNABLE;
}

// exec
if(p->group_leader != p)
  return -1;
...
drain_siblings(p);
p->mm->pagetable = pagetable;
p->mm->sz = sz;`,
    points: [
      ["exit", "leader는 sibling을 kill하고 동기적으로 reap합니다. non-leader는 자기만 zombie가 됩니다."],
      ["kill", "target pid가 leader가 아니어도 target group 전체를 종료 대상으로 만듭니다."],
      ["exec", "non-leader exec는 금지하고, leader exec는 성공 commit 직전에 sibling을 정리합니다."]
    ],
    details: [
      ["p->group_leader == p", "현재 proc가 thread group의 대표인지 확인합니다. leader가 exit한다는 것은 process 전체가 끝나는 의미에 가깝습니다."],
      ["drain_siblings(p)", "leader를 제외한 같은 group의 thread들에게 killed 표시를 하고, 끝날 때까지 기다린 뒤 zombie sibling을 정리합니다."],
      ["non-leader exit", "일반 thread가 exit하면 group 전체를 닫지 않습니다. 자기만 ZOMBIE가 되고 나중에 join으로 회수됩니다."],
      ["p->state != UNUSED", "kill을 처리할 때 비어 있는 proc table slot은 건너뜁니다."],
      ["p->group_leader == leader || p->tgid == tgid", "kill 인자로 leader pid가 아니라 thread pid가 들어와도, target이 속한 thread group 전체를 찾기 위한 조건입니다."],
      ["p->killed = 1", "즉시 메모리에서 지우는 것이 아니라 '너는 종료되어야 한다'는 표시를 남깁니다. xv6는 이 플래그를 보고 안전한 지점에서 exit합니다."],
      ["SLEEPING -> RUNNABLE", "자고 있는 thread는 killed를 확인하지 못할 수 있으므로 깨웁니다. 다시 실행되면 killed를 보고 종료 흐름으로 갑니다."],
      ["p->group_leader != p", "exec는 주소 공간 전체를 새 프로그램으로 바꾸므로 leader만 허용합니다. 일반 thread가 exec하면 같은 page table을 쓰는 sibling들의 실행 기반이 갑자기 사라질 수 있습니다."],
      ["drain_siblings before commit", "exec 준비가 성공한 뒤 실제 page table을 교체하기 직전에 sibling을 정리합니다. 초반에 죽이면 exec 실패 시 기존 thread group을 불필요하게 망가뜨립니다."],
      ["p->mm->pagetable = pagetable", "mm_struct 자체는 유지하고 그 안의 page table을 새 프로그램 이미지로 교체합니다."],
      ["p->mm->sz = sz", "새 프로그램이 사용하는 user memory 크기도 함께 갱신합니다."]
    ]
  },
  userlib: {
    title: "user/uthread.c: user-level wrapper의 책임",
    summary: "kernel system call은 primitive만 제공하고, stack allocation/free는 user library가 담당합니다.",
    snippet: `int
thread_create(void (*fn)(void *), void *arg, int n_pages)
{
  if(n_pages <= 0)
    return -1;
  void *stack = malloc(n_pages * PGSIZE);
  if(stack == 0)
    return -1;
  int pid = clone(fn, arg, stack, n_pages, CLONE_VM);
  if(pid < 0){
    free(stack);
    return -1;
  }
  return pid;
}

int
thread_join(void)
{
  void *stack = 0;
  int pid = join(&stack);
  if(pid < 0)
    return -1;
  if(stack)
    free(stack);
  return pid;
}`,
    points: [
      ["malloc", "thread stack은 user heap에서 잡습니다."],
      ["clone 실패", "이미 잡은 stack을 즉시 free하여 leak을 막습니다."],
      ["join 성공", "kernel이 돌려준 stack base를 free하여 stack lifetime을 닫습니다."]
    ],
    details: [
      ["n_pages <= 0", "stack 크기가 0 page 이하이면 thread를 시작할 user stack이 없으므로 실패합니다."],
      ["malloc(n_pages * PGSIZE)", "thread stack은 kernel이 아니라 user library가 user heap에서 잡습니다."],
      ["clone(... CLONE_VM)", "kernel에는 thread primitive로 clone을 요청합니다. CLONE_VM을 넘기기 때문에 부모 mm_struct를 공유하는 thread가 됩니다."],
      ["clone 실패 시 free(stack)", "stack을 먼저 malloc했으므로 clone이 실패하면 즉시 free해야 user heap leak이 생기지 않습니다."],
      ["join(&stack)", "kernel join은 종료된 thread의 ustack 주소를 user 변수 stack에 써줍니다."],
      ["free(stack)", "stack은 user malloc으로 잡은 것이므로 user library의 thread_join()이 free합니다. kernel은 user heap allocator를 직접 다루지 않습니다."]
    ]
  }
};

const scenarios = {
  create: {
    title: "thread_create → clone → join",
    intro: "가장 기본적인 thread lifecycle입니다. 여기서 stack lifetime과 mm refcount가 같이 움직입니다.",
    steps: [
      ["thread_create", "user library가 stack = malloc(n_pages * PGSIZE)를 수행합니다."],
      ["sys_clone", "인자를 받아 kclone(fn, arg, stack, n_pages, CLONE_VM)을 호출합니다."],
      ["kclone thread path", "부모 mm을 공유하고 refcount를 올린 뒤 새 trapframe slot을 mapping합니다."],
      ["thread function 실행", "새 task는 epc=fn, a0=arg, sp=stack top으로 user mode에 들어갑니다."],
      ["exit", "thread function이 끝나거나 exit하면 non-leader task만 ZOMBIE가 됩니다."],
      ["thread_join", "join이 zombie thread의 ustack을 copyout하고 freeproc합니다. user wrapper가 free(stack)을 호출합니다."]
    ]
  },
  "leader-exit": {
    title: "leader exit",
    intro: "leader가 종료되면 thread group의 주소 공간 전체가 사라지는 방향으로 정리되어야 합니다.",
    steps: [
      ["kexit 진입", "현재 task가 group_leader인지 검사합니다."],
      ["drain_siblings", "leader가 아닌 같은 group task들에 killed=1을 설정하고 SLEEPING이면 깨웁니다."],
      ["동기 대기", "sibling들이 ZOMBIE 또는 UNUSED가 될 때까지 leader가 기다립니다."],
      ["reap", "ZOMBIE sibling을 freeproc으로 회수합니다."],
      ["leader zombie", "leader 자신은 일반 exit 흐름대로 ZOMBIE가 되어 parent의 wait 대상이 됩니다."]
    ]
  },
  exec: {
    title: "leader exec / non-leader exec",
    intro: "exec는 주소 공간 전체를 교체하므로 thread group에서 특히 조심해야 합니다.",
    steps: [
      ["non-leader", "p->group_leader != p이면 즉시 -1을 반환합니다."],
      ["leader 준비", "ELF open, segment load, argument copy를 새 page table에서 먼저 시도합니다."],
      ["실패 시", "아직 기존 sibling을 죽이지 않았으므로 원래 thread group이 유지됩니다."],
      ["commit 직전", "성공이 확정되는 시점에 drain_siblings(p)를 호출합니다."],
      ["page table 교체", "p->mm->pagetable과 p->mm->sz를 새 image로 바꾼 뒤 old page table을 free합니다."]
    ]
  },
  kill: {
    title: "kill(tid)",
    intro: "Q&A에서 확인한 중요한 edge case입니다. kill 인자는 leader pid가 아니라 thread pid일 수도 있습니다.",
    steps: [
      ["target 탐색", "pid와 일치하는 proc를 찾습니다."],
      ["group 식별", "target의 group_leader와 tgid를 저장합니다."],
      ["전체 표시", "같은 group_leader 또는 같은 tgid를 가진 task 전체에 killed=1을 설정합니다."],
      ["sleeping wakeup", "잠든 thread는 RUNNABLE로 바꿔 trap/syscall return 경로에서 exit할 수 있게 합니다."],
      ["결과", "leader pid가 아닌 tid를 kill해도 thread group 전체가 종료 방향으로 갑니다."]
    ]
  },
  fork: {
    title: "non-leader fork",
    intro: "thread가 fork를 호출할 수 있는지와 child가 어느 group에 속하는지가 헷갈리기 쉽습니다.",
    steps: [
      ["caller", "fork를 호출한 non-leader thread가 child의 parent가 됩니다."],
      ["clone(0)", "fork wrapper는 CLONE_VM 없이 kclone을 호출합니다."],
      ["새 mm", "child는 부모 mm을 공유하지 않고 새 mm_struct와 새 page table을 받습니다."],
      ["새 group", "child의 group_leader는 child 자신이고 tgid는 child pid입니다."],
      ["의미", "fork로 만들어진 child는 기존 thread group의 새 thread가 아니라 독립 process입니다."]
    ]
  },
  sbrk: {
    title: "sbrk와 vmfault caveat",
    intro: "공유 page table에서 memory grow/shrink와 lazy allocation은 race condition을 만들 수 있습니다.",
    steps: [
      ["문제", "한 thread가 vmfault로 page를 mapping하는 동안 다른 thread가 sbrk(-n)으로 unmap할 수 있습니다."],
      ["Q&A", "해당 race는 명백히 있지만 채점 테스트에는 포함하지 않는다고 안내되었습니다."],
      ["우리 선택", "vm.c는 수정하지 않고, growproc에서 mm->refcount > 1이면 shrink를 no-op 성공으로 처리했습니다."],
      ["한계", "완전한 해결은 vmfault, kclone, growproc 전체에 일관된 page table locking을 설계해야 합니다."],
      ["학습 포인트", "thread 구현은 단순히 구조체 필드를 나누는 문제가 아니라 공유 resource synchronization 문제입니다."]
    ]
  }
};

let refThreads = 1;
let usedSlots = 1;
let slides = [];
let currentSlide = 0;

function getSlideLabel(slide, index) {
  if (slide.dataset.title) return slide.dataset.title;
  const heading = slide.querySelector("h1, h2, h3");
  return heading ? heading.textContent.trim() : `Slide ${index + 1}`;
}

function renderSlideRail() {
  const rail = document.querySelector("#slide-rail-list");
  rail.innerHTML = slides.map((slide, index) => `
    <button class="rail-button" type="button" data-slide-index="${index}">
      <span>${index + 1}</span>
      ${getSlideLabel(slide, index)}
    </button>
  `).join("");

  rail.querySelectorAll(".rail-button").forEach(button => {
    button.addEventListener("click", () => showSlide(Number(button.dataset.slideIndex)));
  });
}

function showSlide(index, target = null) {
  if (!slides.length) return;

  currentSlide = Math.max(0, Math.min(slides.length - 1, index));
  slides.forEach((slide, slideIndex) => {
    const active = slideIndex === currentSlide;
    slide.classList.toggle("active", active);
    slide.setAttribute("aria-hidden", active ? "false" : "true");
    if (active) slide.scrollTop = 0;
  });

  document.querySelectorAll(".rail-button").forEach((button, buttonIndex) => {
    button.classList.toggle("active", buttonIndex === currentSlide);
  });

  const counter = document.querySelector("#slide-counter");
  const progress = document.querySelector("#deck-progress");
  const prev = document.querySelector("#prev-slide");
  const next = document.querySelector("#next-slide");

  counter.textContent = `${currentSlide + 1} / ${slides.length}`;
  progress.style.width = `${((currentSlide + 1) / slides.length) * 100}%`;
  prev.disabled = currentSlide === 0;
  next.disabled = currentSlide === slides.length - 1;

  const slide = slides[currentSlide];
  history.replaceState(null, "", `#${slide.id}`);

  if (target && target !== slide) {
    requestAnimationFrame(() => target.scrollIntoView({ block: "start", behavior: "smooth" }));
  } else if (window.matchMedia("(max-width: 720px)").matches) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function bindDeckNavigation() {
  slides = Array.from(document.querySelectorAll(".slide"));
  renderSlideRail();

  document.querySelector("#prev-slide").addEventListener("click", () => showSlide(currentSlide - 1));
  document.querySelector("#next-slide").addEventListener("click", () => showSlide(currentSlide + 1));

  document.addEventListener("keydown", event => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      showSlide(currentSlide + 1);
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      showSlide(currentSlide - 1);
    }
    if (event.key === "Home") {
      event.preventDefault();
      showSlide(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      showSlide(slides.length - 1);
    }
  });

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener("click", event => {
      const id = anchor.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (!target) return;
      const slide = target.classList.contains("slide") ? target : target.closest(".slide");
      if (!slide) return;
      event.preventDefault();
      showSlide(slides.indexOf(slide), target);
    });
  });

  const hashTarget = location.hash ? document.getElementById(location.hash.slice(1)) : null;
  const hashSlide = hashTarget ? (hashTarget.classList.contains("slide") ? hashTarget : hashTarget.closest(".slide")) : null;
  showSlide(hashSlide ? slides.indexOf(hashSlide) : 0, hashTarget);
}

function renderCloneMode(mode) {
  const output = document.querySelector("#clone-output");
  output.innerHTML = cloneModes[mode].map(item => `
    <article>
      <strong>${item.title}</strong>
      <span>${item.text}</span>
    </article>
  `).join("");
}

function renderRefSim() {
  const count = document.querySelector("#ref-count");
  const dots = document.querySelector("#thread-dots");
  count.textContent = `refcount = ${refThreads}`;
  dots.innerHTML = Array.from({ length: refThreads }, (_, index) => `
    <span class="thread-dot ${index === 0 ? "leader" : ""}">${index === 0 ? "p0" : `t${index}`}</span>
  `).join("");
}

function renderSlots() {
  const grid = document.querySelector("#slot-grid");
  grid.innerHTML = Array.from({ length: 8 }, (_, index) => {
    const used = index < usedSlots;
    return `<div class="slot ${used ? "used" : ""}">
      <span>slot ${index}</span>
      <small>${used ? "mapped" : "free"}</small>
    </div>`;
  }).join("");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderCode(key) {
  const data = codeSections[key];
  const panel = document.querySelector("#code-panel");
  panel.innerHTML = `
    <h3>${escapeHtml(data.title)}</h3>
    <p class="code-summary">${escapeHtml(data.summary)}</p>
    <pre><code>${escapeHtml(data.snippet)}</code></pre>
    <ul class="code-points">
      ${data.points.map(([name, text]) => `<li><strong>${escapeHtml(name)}</strong>${escapeHtml(text)}</li>`).join("")}
    </ul>
    <div class="code-deep-dive">
      <h4>흐름을 이렇게 읽기</h4>
      <ol>
        ${data.details.map(([term, text]) => `
          <li>
            <code>${escapeHtml(term)}</code>
            <span>${escapeHtml(text)}</span>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderScenario(key) {
  const data = scenarios[key];
  const panel = document.querySelector("#scenario-panel");
  panel.innerHTML = `
    <h3>${data.title}</h3>
    <p>${data.intro}</p>
    <div class="trace">
      ${data.steps.map(([title, text]) => `
        <div class="trace-step">
          <strong>${title}</strong>
          <span>${text}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function bindCloneSwitch() {
  document.querySelectorAll(".switch-button").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".switch-button").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      renderCloneMode(button.dataset.mode);
    });
  });
}

function bindRefSim() {
  document.querySelector("#add-thread").addEventListener("click", () => {
    refThreads = Math.min(8, refThreads + 1);
    renderRefSim();
  });

  document.querySelector("#join-thread").addEventListener("click", () => {
    refThreads = Math.max(1, refThreads - 1);
    renderRefSim();
  });

  document.querySelector("#reset-ref").addEventListener("click", () => {
    refThreads = 1;
    renderRefSim();
  });
}

function bindSlots() {
  document.querySelector("#alloc-slot").addEventListener("click", () => {
    usedSlots = Math.min(8, usedSlots + 1);
    renderSlots();
  });

  document.querySelector("#free-slot").addEventListener("click", () => {
    usedSlots = Math.max(1, usedSlots - 1);
    renderSlots();
  });

  document.querySelector("#reset-slots").addEventListener("click", () => {
    usedSlots = 1;
    renderSlots();
  });
}

function bindCodeTabs() {
  document.querySelectorAll(".code-tab").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".code-tab").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      renderCode(button.dataset.code);
    });
  });
}

function bindScenarios() {
  document.querySelectorAll(".scenario-button").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".scenario-button").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      renderScenario(button.dataset.scenario);
    });
  });
}

function bindQuiz() {
  document.querySelectorAll(".quiz-card").forEach(card => {
    card.addEventListener("click", () => {
      card.classList.toggle("open");
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderCloneMode("fork");
  renderRefSim();
  renderSlots();
  renderCode("memory");
  renderScenario("create");
  bindDeckNavigation();
  bindCloneSwitch();
  bindRefSim();
  bindSlots();
  bindCodeTabs();
  bindScenarios();
  bindQuiz();
});
