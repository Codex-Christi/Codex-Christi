'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/UI/primitives/button';
import { TiChevronRight } from 'react-icons/ti';
import useAuthStore from '@/stores/authStore';

const WaitlistButton = () => {
  const router = useRouter();

  // Use a simple selector so React/Zustand can memoize properly
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const handleClick = () => {
    if (isAuthenticated) {
      router.push('/profile');
    } else {
      router.push('/auth/signup');
    }
  };

  const label = isAuthenticated ? 'View Profile' : 'Join waitlist';

  return (
    <Button
      name='Join Waitlist Button'
      onClick={handleClick}
      variant='secondary'
      className={`mt-[150px] md:mt-[144px] lg:mt-[136px] !mx-auto font-inter
         bg-white text-black font-bold text-[1.15rem] py-3 !h-[unset] flex`}
    >
      <h3>{label}</h3>
      {!isAuthenticated && <TiChevronRight className='text-[1.5rem] text-black ml-2' size={20} />}
    </Button>
  );
};

export default WaitlistButton;
