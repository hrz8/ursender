<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use Illuminate\Foundation\Auth\ResetsPasswords;
use Illuminate\Support\Facades\Auth;

class ResetPasswordController extends Controller
{
    /*
    |--------------------------------------------------------------------------
    | Password Reset Controller
    |--------------------------------------------------------------------------
    |
    | This controller is responsible for handling password reset requests
    | and uses a simple trait to include this behavior. You're free to
    | explore this trait and override any methods you wish to tweak.
    |
    */

    use ResetsPasswords;

    /**
     * Where to redirect users after resetting their password.
     *
     * @var string
     */
    public function redirectTo()
    {
        if (Auth::user()->role == 'user') {
            return  $this->redirectTo = '/user/dashboard';
        } elseif (Auth::user()->role == 'admin') {
            $this->redirectTo = '/admin/dashboard';

            return $this->redirectTo;
        }

        $this->middleware('guest')->except('logout');
    }
}
