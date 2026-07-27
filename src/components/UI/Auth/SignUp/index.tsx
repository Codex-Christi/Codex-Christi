import Link from 'next/link';
import SignUpForm from '@/components/UI/Auth/SignUp/SignUpForm';
import GoogleIcon from '@/components/UI/general/IconComponents/GoogleIcon';
import AppleIcon from '@/components/UI/general/IconComponents/AppleIcon';
import GitHubIcon from '@/components/UI/general/IconComponents/GitHubIcon';
import { FC } from 'react';

const SignUpMainComponent: FC = () => {
  return (
    <>
      <aside
        aria-label='Shop alpha notice'
        className='mx-auto mt-8 w-[80%] max-w-[425px] rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-center text-sm leading-6 text-amber-50 sm:w-[70%] md:w-[50%] lg:w-full'
      >
        <span className='font-semibold text-amber-200'>Shop alpha:</span>{' '}
        Creating your Codex Christi account also joins the shop alpha waitlist. Some shop features
        are still being completed and may not work fully.
      </aside>

      <SignUpForm />

      <div className='space-y-8 text-center'>
        <div className='space-y-4 lg:w-4/5 lg:mx-auto'>
          <p>or Sign Up with</p>

          <div className='flex place-content-center justify-between gap-4 mx-auto'>
            <Link href=''>
              <GoogleIcon />
            </Link>

            <Link href=''>
              <AppleIcon />
            </Link>

            <Link href=''>
              <GitHubIcon />
            </Link>
          </div>
        </div>

        <p>
          Already have an account?{' '}
          <Link className='font-bold' href='/auth/sign-in'>
            Login
          </Link>
        </p>
      </div>
    </>
  );
};

export default SignUpMainComponent;
